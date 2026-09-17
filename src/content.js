(async function () {
    'use strict';

    // Frame history entry: { ts, src, isBitmap }
    // src is an ImageBitmap (async, off-main-thread capture) or an
    // HTMLCanvasElement (synchronous fallback).

    class FrameSync {
        /**
         * @param {HTMLVideoElement} video
         * @param {number} maxBuffer (kept for signature compatibility; the ring is
         *                           time-pruned now, not count-based)
         * @param {number} frameDelayMs
         */
        constructor(video, maxBuffer, frameDelayMs) {
            if (video.frameSyncObj) {
                video.frameSyncObj.frameDelayMs = frameDelayMs;
                return video.frameSyncObj;
            }

            this.video = video;
            this.frameDelayMs = frameDelayMs;
            this.active = false;

            this.entries = []; // sorted by ts
            this._outstanding = 0;
            this._outstandingCap = 6;
            this._captureFailures = 0;
            this._bitmapMode = typeof createImageBitmap === 'function'; // 'opts' | 'plain' | false
            this._bitmapPlain = false; // true when resize options are unsupported
            this._canvasPool = [];

            this.lastDrawnTs = -1;
            this.canvas = null;
            this.ctx = null;
            this.resizeObserver = null;
            this.isSeeking = false;
            this._dims = null;

            this._savedOpacity = null;
            this._overlayTookOver = false;

            this._seekingFunc = () => {
                this.isSeeking = true;
                this._flushEntries();
                if (this.ctx && this.canvas) {
                    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                }
                this.lastDrawnTs = -1;
                // Show the real video while seeking (loader / seek previews)
                this._showOriginalVideo();
            };

            this._seekedFunc = () => {
                this.isSeeking = false;
            };

            // HTMLVideoElement 'resize' fires when videoWidth/videoHeight change
            // (e.g. YouTube quality switch). ResizeObserver only watches the CSS
            // layout box, which does not change in that case.
            this._videoResizeFunc = () => {
                this._flushEntries();
                this.lastDrawnTs = -1;
                this.Resize();
            };

            this.video.addEventListener('seeking', this._seekingFunc);
            this.video.addEventListener('seeked', this._seekedFunc);
            this.video.addEventListener('resize', this._videoResizeFunc);

            video.frameSyncObj = this;
            this._captureRAFFunc = this._captureRAF.bind(this);
            this._drawFrameFunc = this._drawFrame.bind(this);
            this._resizeFunc = this.Resize.bind(this);
        }

        // Buffer/overlay size = video resolution, but never larger than the
        // on-screen size * devicePixelRatio (capped at 2).
        _targetDims() {
            const video = this.video;
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            if (!vw || !vh) return null;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const rect = video.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const wantW = Math.ceil(rect.width * dpr);
                const wantH = Math.ceil(rect.height * dpr);
                if (wantW < vw || wantH < vh) {
                    const scale = Math.min(wantW / vw, wantH / vh);
                    return {
                        w: Math.max(2, Math.round(vw * scale)),
                        h: Math.max(2, Math.round(vh * scale)),
                    };
                }
            }
            return { w: vw, h: vh };
        }

        _freeSrc(entry) {
            if (entry.isBitmap && entry.src && typeof entry.src.close === 'function') {
                try { entry.src.close(); } catch (e) { }
            } else if (entry.src) {
                this._canvasPool.push(entry.src);
            }
        }

        _flushEntries() {
            for (const e of this.entries) this._freeSrc(e);
            this.entries = [];
        }

        _pruneOldEntries(now) {
            const cutoff = now - this.frameDelayMs - 250;
            while (this.entries.length && this.entries[0].ts < cutoff) {
                this._freeSrc(this.entries.shift());
            }
            // Hard safety cap
            while (this.entries.length > 150) {
                this._freeSrc(this.entries.shift());
            }
        }

        _insertEntry(ts, src, isBitmap) {
            let i = this.entries.length;
            while (i > 0 && this.entries[i - 1].ts > ts) i--;
            this.entries.splice(i, 0, { ts, src, isBitmap });
        }

        _captureCanvasFrame(ts) {
            if (!this._dims) {
                this._dims = this._targetDims();
                if (!this._dims) return;
            }
            const dims = this._dims;
            let c = this._canvasPool.pop();
            if (!c) c = document.createElement('canvas');
            if (c.width !== dims.w || c.height !== dims.h) {
                c.width = dims.w;
                c.height = dims.h;
            }
            try {
                c.getContext('2d').drawImage(this.video, 0, 0, dims.w, dims.h);
                this._captureFailures = 0;
                this._insertEntry(ts, c, false);
            } catch (e) {
                this._canvasPool.push(c);
                this._captureFailures++;
                if (this._captureFailures > 30) {
                    // e.g. DRM-protected content: give up on this video
                    this.Deactivate();
                }
            }
        }

        _captureFrame(ts) {
            if (this._bitmapMode) {
                if (this._outstanding >= this._outstandingCap) return; // skip tick
                if (!this._dims) {
                    this._dims = this._targetDims();
                    if (!this._dims) return;
                }
                const dims = this._dims;
                this._outstanding++;
                const opts = this._bitmapPlain
                    ? undefined
                    : { resizeWidth: dims.w, resizeHeight: dims.h };
                const promise = opts
                    ? createImageBitmap(this.video, opts)
                    : createImageBitmap(this.video);
                promise.then(bitmap => {
                    this._outstanding--;
                    if (!this.active) {
                        try { bitmap.close(); } catch (e) { }
                        return;
                    }
                    this._captureFailures = 0;
                    this._insertEntry(ts, bitmap, true);
                }).catch(() => {
                    this._outstanding--;
                    if (!this._bitmapPlain) {
                        // Resize options unsupported: retry plain bitmaps, but only
                        // for modest resolutions (plain bitmaps are full-size).
                        const big = this.video.videoWidth * this.video.videoHeight > 2560 * 1440;
                        if (!big) {
                            this._bitmapPlain = true;
                            this._captureFrame(ts);
                            return;
                        }
                    }
                    this._bitmapMode = false;
                    this._captureCanvasFrame(ts);
                });
            } else {
                this._captureCanvasFrame(ts);
            }
        }

        // Capture loop on the display refresh (rAF). requestVideoFrameCallback
        // would pace captures to presented frames, but Firefox throttles rVFC
        // to ~40 ms (25 Hz) on the real decoded-video path (bug 1935256,
        // verified on Firefox 155: 24.4 Hz callbacks vs 51.8 fps presented),
        // silently halving the capture rate for >25 fps content. rAF at display
        // rate never under-samples, and async bitmap capture keeps duplicates cheap.
        _captureRAF(now) {
            if (!this.active) return;
            if (!this.video.paused && !document.hidden && !this.isSeeking) {
                this._captureFrame(now);
            }
            requestAnimationFrame(this._captureRAFFunc);
        }

        _drawFrame(now) {
            if (!this.active) return; // end the loop when deactivated
            if (this.video.paused || this.isSeeking) {
                window.requestAnimationFrame(this._drawFrameFunc);
                return;
            }

            this._pruneOldEntries(now);

            const target = now - this.frameDelayMs;
            // Most recent frame that is "due" (monotonic presentation, no
            // back-and-forth between neighbouring frames).
            let due = null;
            for (let i = this.entries.length - 1; i >= 0; i--) {
                if (this.entries[i].ts <= target) {
                    due = this.entries[i];
                    break;
                }
            }

            if (due && due.ts !== this.lastDrawnTs && due.src && due.src.width > 0) {
                try {
                    this.ctx.drawImage(due.src, 0, 0, this.canvas.width, this.canvas.height);
                    this.lastDrawnTs = due.ts;
                    if (!this._overlayTookOver) {
                        // First delayed frame is on screen - hide the live video below
                        this._overlayTookOver = true;
                        if (this._savedOpacity === null) {
                            this._savedOpacity = this.video.style.opacity;
                        }
                        this.video.style.opacity = '0';
                    }
                } catch (e) {
                    console.error('FrameSync: Error drawing frame.', e);
                }
            }

            window.requestAnimationFrame(this._drawFrameFunc);
        }

        _showOriginalVideo() {
            if (this._overlayTookOver) {
                this._overlayTookOver = false;
                if (this._savedOpacity !== null) {
                    this.video.style.opacity = this._savedOpacity;
                    this._savedOpacity = null;
                }
            }
        }

        Resize = () => {
            if (!this.canvas) return;
            const video = this.video;
            if (video.videoWidth === 0 || video.videoHeight === 0) return;

            const dims = this._targetDims();
            if (!dims) return;
            this._dims = dims;
            this.canvas.width = dims.w;
            this.canvas.height = dims.h;

            const videoStyle = window.getComputedStyle(video);
            this.canvas.style.width = videoStyle.width;
            this.canvas.style.height = videoStyle.height;
            this.canvas.style.left = `${video.offsetLeft}px`;
            this.canvas.style.top = `${video.offsetTop}px`;
            this.canvas.style.objectFit = videoStyle.objectFit;
            this.canvas.style.transform = videoStyle.transform;
        };

        _createCanvasOverlay() {
            if (this.canvas) return;

            const canvas = document.createElement('canvas');
            const video = this.video;

            canvas.style.position = 'absolute';
            const videoStyle = window.getComputedStyle(video);
            canvas.style.zIndex = (parseInt(videoStyle.zIndex, 10) || 0) + 1;
            canvas.style.pointerEvents = 'none';

            video.parentElement.appendChild(canvas);

            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.Resize();

            this.resizeObserver = new ResizeObserver(this._resizeFunc);
            this.resizeObserver.observe(this.video);
        }

        Activate() {
            if (this.active) return;
            this.active = true;
            this._createCanvasOverlay();
            requestAnimationFrame(this._captureRAFFunc);
            window.requestAnimationFrame(this._drawFrameFunc);
        }

        Deactivate() {
            this.active = false;

            this.video.removeEventListener('seeking', this._seekingFunc);
            this.video.removeEventListener('seeked', this._seekedFunc);
            this.video.removeEventListener('resize', this._videoResizeFunc);

            this._flushEntries();
            this._showOriginalVideo();

            if (this.canvas) {
                this.canvas.remove();
                this.canvas = null;
                this.ctx = null;
            }
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
                this.resizeObserver = null;
            }
            delete this.video.frameSyncObj;
        }
    }

    // --- Main Logic ---

    let currentFrameDelay = 0;
    let isPaused = false;

    const updateSyncForVideos = () => {
        const videoList = document.querySelectorAll('video');
        videoList.forEach(video => {
            if (currentFrameDelay > 0 && !isPaused) {
                if (!video.frameSyncObj) {
                    const frameSync = new FrameSync(video, 16, currentFrameDelay);
                    frameSync.Activate();
                } else {
                    video.frameSyncObj.frameDelayMs = currentFrameDelay;
                }
            } else {
                if (video.frameSyncObj) {
                    video.frameSyncObj.Deactivate();
                }
            }
        });
    };

    const initialize = async () => {
        const { frameDelay, pauseDelay } = await browser.storage.sync.get(['frameDelay', 'pauseDelay']);
        currentFrameDelay = parseInt(frameDelay, 10) || 0;
        isPaused = pauseDelay || false;
        updateSyncForVideos();
    };

    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') {
            if (changes.frameDelay) {
                currentFrameDelay = parseInt(changes.frameDelay.newValue, 10) || 0;
            }
            if (changes.pauseDelay) {
                isPaused = changes.pauseDelay.newValue || false;
            }
            updateSyncForVideos();
        }
    });

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.tagName === 'VIDEO') {
                    updateSyncForVideos();
                } else if (node.querySelectorAll) {
                    node.querySelectorAll('video').forEach(() => updateSyncForVideos());
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    initialize();
})();
