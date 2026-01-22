(async function () {
    'use strict';
    class BufferFrame {
        /**
         * @param {HTMLVideoElement} video
         */
        constructor(video) {
            const frame = document.createElement('canvas');
            this.frame = frame;
            this.video = video;
            this.captureTs = 0;
            this.Resize();
        }
        CaptureFrame(now) {
            // Only draw if the video has valid dimensions
            if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
                this.ctx.drawImage(this.video, 0, 0, this.frame.width, this.frame.height);
                this.captureTs = now;
            }
        }
        Resize() {
            const frame = this.frame;
            const video = this.video;
            frame.width = video.videoWidth;
            frame.height = video.videoHeight;
            // The context needs to be retrieved again after a resize
            this.ctx = this.frame.getContext('2d');
        }
    }

    class FrameSync {
        /**
         * @param {HTMLVideoElement} video 
         * @param {number} maxBuffer 
         * @param {number} frameDelayMs 
         */
        constructor(video, maxBuffer, frameDelayMs) {
            if (video.frameSyncObj) {
                // If it already exists, just update the delay
                video.frameSyncObj.frameDelayMs = frameDelayMs;
                return video.frameSyncObj;
            }

            this.video = video;
            this.buffer = [];
            this.maxBuffer = 0;
            this.frameDelayMs = frameDelayMs;
            this.active = false;
            this.frameCount = 0;
            this.lastDrawnFrameIndex = -1; // Keep track of what we last drew
            this.resizeObserver = null; // For efficient resize detection

            this.SetMaxBuffer(maxBuffer);
            video.frameSyncObj = this;
            this._captureFrameFunc = this._captureFrame.bind(this);
            this._drawFrameFunc = this._drawFrame.bind(this);
            this._resizeFunc = this.Resize.bind(this);
        }

        SetMaxBuffer(maxBuffer) {
            if (maxBuffer < 2) {
                console.error('maxBuffer should be at least 2');
                return;
            }

            this.maxBuffer = maxBuffer;
            this.buffer = []; // Re-initialize buffer
            for (let i = 0; i < this.maxBuffer; i++) {
                this.buffer.push(new BufferFrame(this.video));
            }
            this.frameCount = 0;
            this.lastDrawnFrameIndex = -1;
        }

        Resize = () => {
            if (!this.canvas) return;
            const video = this.video;
            const canvas = this.canvas;

            // Check if video has valid dimensions before resizing
            if (video.videoWidth === 0 || video.videoHeight === 0) return;

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const videoStyle = window.getComputedStyle(video);
            canvas.style.width = videoStyle.width;
            canvas.style.height = videoStyle.height;
            canvas.style.left = `${video.offsetLeft}px`;
            canvas.style.top = `${video.offsetTop}px`;
            canvas.style.objectFit = videoStyle.objectFit;
            canvas.style.transform = videoStyle.transform;

            for (let i = 0; i < this.maxBuffer; i++) {
                this.buffer[i].Resize();
            }
        };

        _createCanvasOverlay() {
            if (this.canvas) return; // Don't create if it already exists

            const canvas = document.createElement('canvas');
            const video = this.video;

            canvas.style.position = 'absolute';
            const videoStyle = window.getComputedStyle(video);
            canvas.style.zIndex = (parseInt(videoStyle.zIndex, 10) || 0) + 1; // Ensure canvas is on top
            canvas.style.pointerEvents = 'none';

            video.parentElement.appendChild(canvas);

            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.Resize();

            // OPTIMIZATION 1: Use ResizeObserver instead of setInterval
            this.resizeObserver = new ResizeObserver(this._resizeFunc);
            this.resizeObserver.observe(this.video);
        }

        _captureFrame(now, metadata) {
            // Stop capturing if the video is paused, hidden, or the extension is inactive
            if (!this.active || this.video.paused || document.hidden) {
				//Needed to add a requestAnimationFrame call here as the video freezes in certain edge cases (changing tabs, clicking through video, disabling addon, etc.)
				requestAnimationFrame(this._captureFrameFunc);
                return;
            }
            
            // Check for buffer overflow without resizing aggressively
            const nextFrameIndex = this.frameCount % this.maxBuffer;
            if (this.buffer[nextFrameIndex].captureTs !== 0 && now - this.buffer[nextFrameIndex].captureTs < this.frameDelayMs) {
                console.warn('FrameSync: Buffer overflow detected. Video might stutter. Consider increasing buffer or checking performance.');
                // We just overwrite the frame instead of resizing the buffer, which is smoother.
            }

            this.buffer[nextFrameIndex].CaptureFrame(now);
            this.frameCount++;

            // Continue the capture loop
            //this.video.requestVideoFrameCallback(this._captureFrameFunc);  <--seems to limit framerate to 30 fps
			requestAnimationFrame(this._captureFrameFunc);
        }
        
        // OPTIMIZATION 2: Simpler and more efficient frame selection logic
        _findBestFrameToShow(targetTs) {
            let bestFrameIndex = -1;
            let smallestDiff = Infinity;

            // Search the buffer for the frame closest to our target timestamp
            for (let i = 0; i < this.buffer.length; i++) {
                const frame = this.buffer[i];
                if (frame.captureTs === 0) continue; // Skip empty frames

                const diff = Math.abs(frame.captureTs - targetTs);
                if (diff < smallestDiff) {
                    smallestDiff = diff;
                    bestFrameIndex = i;
                }
            }
            return bestFrameIndex;
        }


        _drawFrame(now) {
            if (!this.active || this.video.paused) {
                window.requestAnimationFrame(this._drawFrameFunc);
                return;
            }

            const targetTs = now - this.frameDelayMs;
            const bestFrameIndex = this._findBestFrameToShow(targetTs);

            if (bestFrameIndex !== -1 && bestFrameIndex !== this.lastDrawnFrameIndex) {
                const frameToDraw = this.buffer[bestFrameIndex].frame;
                if (frameToDraw.width > 0 && frameToDraw.height > 0) {
                    try {
                        this.ctx.drawImage(frameToDraw, 0, 0, this.canvas.width, this.canvas.height);
                        this.lastDrawnFrameIndex = bestFrameIndex;
                    } catch (e) {
                        console.error('FrameSync: Error drawing frame.', e);
                    }
                }
            }

            window.requestAnimationFrame(this._drawFrameFunc);
        }

        Activate() {
            if (this.active) return;
            this.active = true;
            this._createCanvasOverlay();
			//this.video.requestVideoFrameCallback(this._captureFrameFunc);  <--- Commented out since we're using requestAnimationFrame function now
            requestAnimationFrame(this._captureFrameFunc);
			window.requestAnimationFrame(this._drawFrameFunc);
        }

        Deactivate() {
            this.active = false;
            if (this.canvas) {
                this.canvas.remove();
                this.canvas = null;
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
                    // Start with a larger buffer to prevent overflow. 60 frames is good for 1 sec at 60fps.
                    const frameSync = new FrameSync(video, 60, currentFrameDelay);
                    frameSync.Activate();
                } else {
                    // Update delay if it has changed
                    video.frameSyncObj.frameDelayMs = currentFrameDelay;
                }
            } else {
                // If delay is 0 or paused, deactivate and cleanup
                if (video.frameSyncObj) {
                    video.frameSyncObj.Deactivate();
                }
            }
        });
    };

    // Initial setup
    const initialize = async () => {
        const { frameDelay, pauseDelay } = await browser.storage.sync.get(['frameDelay', 'pauseDelay']);
        currentFrameDelay = parseInt(frameDelay, 10) || 0;
        isPaused = pauseDelay || false;
        updateSyncForVideos();
    };

    // Listen for changes from the popup
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

    // Run on new videos that might appear later (e.g., on single-page apps)
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