'use strict';

// Continuous multi-frequency wireless audio delay measurement.
//
// Emits short beeps at a rotation of tones, detects when each beep returns
// through the microphone using Goertzel tone detection, and reports per-beep
// and median delay. Runs until stopped. The first beep is treated as a
// warm-up and excluded from the median.
//
// Timing fixes vs. the old one-shot test:
// - every recorded block is timestamped with audioContext.currentTime at
//   delivery, so sample -> time mapping no longer drifts (the old code
//   anchored everything to one timestamp taken before recording really
//   started, which could inflate the result several times);
// - beeps are scheduled at an exact context time (start(when));
// - detection is frequency-selective (Goertzel) with an adaptive noise
//   floor, so ambient noise no longer produces false early/late hits.

const startButton = document.getElementById('startButton');
const useThisDelayButton = document.getElementById('useThisDelayButton');
const resultElement = document.getElementById('result');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas.getContext('2d');
const frequencyInput = document.getElementById('frequencyInput');

const BEEP_DURATION = 0.15;  // seconds
const SCHEDULE_AHEAD = 0.3;  // schedule beeps this far ahead for exact timing
const SEARCH_WINDOW = 2.5;   // seconds after beep start to search for the echo
const WARMUP_BEEPS = 1;      // excluded from median (device may still settle)

let running = false;
let stopRequested = false;

let audioContext = null;
let stream = null;
let sourceNode = null;
let recorder = null;
let warmupOsc = null;

let blocks = [];   // recorded mic blocks: { endTime, data }
let results = [];  // { freq, delay|null, playTime, heardTime|null, warmup }

startButton.addEventListener('click', toggleTest);

function toggleTest() {
    if (running) {
        stopRequested = true;
        startButton.disabled = true;
        startButton.textContent = 'Stopping...';
    } else {
        startTest();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentFrequency() {
    const base = Number.parseFloat(frequencyInput && frequencyInput.value);
    const f = Number.isFinite(base) && base > 0 ? base : 1000;
    // Read live each cycle: the value can be changed while the test runs.
    // Clamp to a range microphones can capture; Bluetooth HFP headset mics
    // are narrow-band, so prefer <= 3400 Hz for those.
    return Math.min(8000, Math.max(100, Math.round(f)));
}

async function waitForContextReady(ctx, timeoutMs = 10000) {
    const t0 = performance.now();
    let last = ctx.currentTime;
    while (performance.now() - t0 < timeoutMs) {
        if (ctx.state === 'suspended') {
            try { await ctx.resume(); } catch (e) { /* retry next tick */ }
        }
        await sleep(100);
        const now = ctx.currentTime;
        if (ctx.state === 'running' && now > last + 0.05) {
            return true;
        }
        last = now;
    }
    return ctx.state === 'running';
}

async function startTest() {
    if (running) return;
    running = true;
    stopRequested = false;
    results = [];
    blocks = [];
    useThisDelayButton.style.display = 'none';
    startButton.disabled = false;
    startButton.textContent = 'Stop Test';

    waveformCanvas.width = window.innerWidth * 0.8;
    waveformCanvas.height = 200;

    resultElement.textContent = 'Initializing...';

    try {
        // Mic first: on Bluetooth headsets opening the mic triggers the
        // A2DP -> HFP profile switch, which stalls output reconfiguration.
        // Do it before any measurement. Disable browser audio processing so
        // the pure tone is not attenuated by noise suppression.
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
        } catch (e) {
            console.error(e);
            resultElement.textContent = 'Failed to get mic permission.';
            return;
        }
        if (stopRequested) return;

        resultElement.textContent = 'Warming up audio device...';
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        warmupOsc = audioContext.createOscillator();
        const warmGain = audioContext.createGain();
        warmGain.gain.value = 0; // silent; just keeps the graph rendering
        warmupOsc.connect(warmGain);
        warmGain.connect(audioContext.destination);
        warmupOsc.start();

        const ready = await waitForContextReady(audioContext);
        await sleep(1000); // settle after profile switching
        try { warmupOsc.stop(); } catch (e) { }
        warmupOsc = null;

        if (!ready) {
            resultElement.textContent = 'Audio output did not start. Check the playback device.';
            return;
        }
        if (stopRequested) return;

        sourceNode = audioContext.createMediaStreamSource(stream);
        recorder = audioContext.createScriptProcessor(4096, 1, 1);
        sourceNode.connect(recorder);
        recorder.connect(audioContext.destination);
        recorder.onaudioprocess = (e) => {
            if (!running) return;
            blocks.push({
                endTime: audioContext.currentTime,
                data: new Float32Array(e.inputBuffer.getChannelData(0)),
            });
            const cutoff = audioContext.currentTime - 15;
            while (blocks.length && blocks[0].endTime < cutoff) blocks.shift();
        };

        let beepIndex = 0;

        while (!stopRequested) {
            const freq = getCurrentFrequency();
            await runBeepCycle(freq, beepIndex);
            beepIndex++;
            if (!stopRequested) updateSummary();
        }
    } catch (e) {
        console.error('Measurement error', e);
        resultElement.textContent = 'An error occurred: ' + (e && e.message ? e.message : e);
    } finally {
        await cleanup();
        running = false;
        startButton.disabled = false;
        startButton.textContent = 'Start Test';
    }
}

async function runBeepCycle(freq, beepIndex) {
    const ctx = audioContext;
    const playTime = ctx.currentTime + SCHEDULE_AHEAD;

    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    osc.type = 'sine';
    osc.connect(ctx.destination);
    osc.start(playTime);
    osc.stop(playTime + BEEP_DURATION);

    resultElement.textContent = `Beep #${beepIndex + 1} @ ${freq} Hz - listening...`;

    // Wait on the context clock (with a wall-clock cap) until the search
    // window has fully passed.
    const deadlineWall = performance.now() + (SCHEDULE_AHEAD + SEARCH_WINDOW + 1.5) * 1000;
    while (!stopRequested &&
        ctx.currentTime < playTime + SEARCH_WINDOW &&
        performance.now() < deadlineWall) {
        await sleep(80);
    }
    try { osc.disconnect(); } catch (e) { }

    if (stopRequested) return;

    const heardTime = detectBeepStart(freq, playTime);
    const delay = heardTime === null ? null : (heardTime - playTime) * 1000;
    results.push({
        freq,
        delay,
        playTime,
        heardTime,
        warmup: beepIndex < WARMUP_BEEPS,
    });
    drawAnalysisWindow(freq, playTime, heardTime);
}

function blockSampleTime(block, i) {
    return block.endTime - (block.data.length - i) / audioContext.sampleRate;
}

function goertzelPower(data, start, len, freq, sampleRate) {
    const coeff = 2 * Math.cos(2 * Math.PI * freq / sampleRate);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < len; i++) {
        const s0 = data[start + i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function detectBeepStart(freq, playTime) {
    const sampleRate = audioContext.sampleRate;
    const hop = Math.max(160, Math.round(sampleRate / 100)); // ~10 ms

    // Adaptive noise floor from the window just before the beep
    const noisePowers = [];
    for (const b of blocks) {
        if (b.endTime < playTime - 0.8) continue;
        if (b.endTime > playTime) break;
        for (let i = 0; i + hop <= b.data.length; i += hop) {
            const t = blockSampleTime(b, i);
            if (t >= playTime - 0.7 && t <= playTime - 0.05) {
                noisePowers.push(goertzelPower(b.data, i, hop, freq, sampleRate));
            }
        }
    }
    noisePowers.sort((a, b) => a - b);
    const noiseMed = noisePowers.length ? noisePowers[Math.floor(noisePowers.length / 2)] : 0;
    const threshold = Math.max(noiseMed * 10, 1);

    // Search forward from the scheduled play time; require two consecutive
    // hot hops to reject transient clicks.
    for (const b of blocks) {
        if (b.endTime < playTime) continue;
        for (let i = 0; i + 2 * hop <= b.data.length; i += hop) {
            const t = blockSampleTime(b, i);
            if (t < playTime - 0.02) continue;
            if (t > playTime + SEARCH_WINDOW) return null;
            const p1 = goertzelPower(b.data, i, hop, freq, sampleRate);
            if (p1 > threshold) {
                const p2 = goertzelPower(b.data, i + hop, hop, freq, sampleRate);
                if (p2 > threshold * 0.3) return t;
            }
        }
    }
    return null;
}

function drawAnalysisWindow(freq, playTime, heardTime) {
    const ctx2d = waveformCtx;
    const width = waveformCanvas.width;
    const height = waveformCanvas.height;
    const t0 = playTime - 0.3;
    const t1 = playTime + SEARCH_WINDOW;
    const span = t1 - t0;
    const axisH = 26;              // bottom strip reserved for the ms scale
    const plotH = height - axisH;

    ctx2d.clearRect(0, 0, width, height);
    ctx2d.fillStyle = 'rgba(200, 200, 200, 0.5)';
    ctx2d.fillRect(0, 0, width, plotH);
    ctx2d.fillStyle = '#e8e8e8';
    ctx2d.fillRect(0, plotH, width, axisH);

    // waveform
    ctx2d.strokeStyle = 'rgb(0, 0, 0)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    let started = false;
    for (const b of blocks) {
        if (b.endTime < t0) continue;
        if (blockSampleTime(b, 0) > t1) break;
        for (let i = 0; i < b.data.length; i += 16) {
            const t = blockSampleTime(b, i);
            if (t < t0 || t > t1) continue;
            const x = ((t - t0) / span) * width;
            const y = (b.data[i] * 0.5 + 0.5) * plotH;
            if (!started) {
                ctx2d.moveTo(x, y);
                started = true;
            } else {
                ctx2d.lineTo(x, y);
            }
        }
    }
    ctx2d.stroke();

    const toX = t => ((t - t0) / span) * width;

    // ms scale anchored at the beep play time: ticks every 100 ms,
    // labels every 500 ms
    ctx2d.strokeStyle = '#555';
    ctx2d.fillStyle = '#333';
    ctx2d.font = '11px Arial';
    ctx2d.textAlign = 'center';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, plotH + 0.5);
    ctx2d.lineTo(width, plotH + 0.5);
    ctx2d.stroke();
    const msStart = Math.ceil((t0 - playTime) * 1000 / 100) * 100;
    const msEnd = (t1 - playTime) * 1000;
    for (let ms = msStart; ms <= msEnd; ms += 100) {
        const x = toX(playTime + ms / 1000);
        const major = ms % 500 === 0;
        ctx2d.beginPath();
        ctx2d.moveTo(x, plotH);
        ctx2d.lineTo(x, plotH + (major ? 9 : 5));
        ctx2d.stroke();
        if (major && x > 26 && x < width - 26) {
            ctx2d.fillText((ms > 0 ? '+' : '') + ms + ' ms', x, plotH + 21);
        }
    }
    ctx2d.textAlign = 'left';

    // red marker: scheduled play time
    const px = toX(playTime);
    ctx2d.strokeStyle = 'red';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(px, 0);
    ctx2d.lineTo(px, plotH);
    ctx2d.stroke();
    ctx2d.fillStyle = 'red';
    ctx2d.font = '12px Arial';
    ctx2d.fillText(`play ${freq} Hz`, px + 5, 15);

    if (heardTime !== null) {
        // blue marker: heard through the mic
        const hx = toX(heardTime);
        ctx2d.strokeStyle = 'blue';
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(hx, 0);
        ctx2d.lineTo(hx, plotH);
        ctx2d.stroke();
        ctx2d.fillStyle = 'blue';
        ctx2d.font = '12px Arial';
        ctx2d.fillText('heard', hx + 5, 32);

        // green bracket with the measured delay between the two markers
        const delayMs = (heardTime - playTime) * 1000;
        const by = 52;
        ctx2d.strokeStyle = '#0a7d00';
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(px, by);
        ctx2d.lineTo(hx, by);
        ctx2d.moveTo(px, by - 5);
        ctx2d.lineTo(px, by + 5);
        ctx2d.moveTo(hx, by - 5);
        ctx2d.lineTo(hx, by + 5);
        ctx2d.stroke();
        const label = `${delayMs.toFixed(0)} ms`;
        ctx2d.font = 'bold 13px Arial';
        const tw = ctx2d.measureText(label).width;
        const lx = Math.min(Math.max((px + hx) / 2 - tw / 2, 2), width - tw - 4);
        ctx2d.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx2d.fillRect(lx - 3, by - 21, tw + 6, 17);
        ctx2d.fillStyle = '#0a7d00';
        ctx2d.fillText(label, lx, by - 8);
    }
}

function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function updateSummary() {
    const last = results[results.length - 1];
    const measured = results.filter(r => !r.warmup && r.delay !== null);
    const lines = [];

    if (last) {
        lines.push(last.delay === null
            ? `Beep #${results.length} @ ${last.freq} Hz: not detected`
            : `Beep #${results.length} @ ${last.freq} Hz: ${last.delay.toFixed(1)} ms${last.warmup ? ' (warm-up)' : ''}`);
    }

    if (measured.length) {
        const med = median(measured.map(r => r.delay));
        const min = Math.min(...measured.map(r => r.delay));
        const max = Math.max(...measured.map(r => r.delay));
        lines.push(`Median: ${med.toFixed(1)} ms (min ${min.toFixed(0)} / max ${max.toFixed(0)}, n=${measured.length})`);
        useThisDelayButton.style.display = 'inline';
        useThisDelayButton.onclick = () => {
            const delayInt = Math.round(med);
            browser.storage.sync.set({ frameDelay: delayInt });
            alert(`Delay saved: ${delayInt} ms`);
        };
    } else {
        lines.push('No valid measurements yet...');
    }

    lines.push('Running - press Stop Test when you have enough samples.');
    resultElement.innerHTML = lines.join('<br>');
}

async function cleanup() {
    try { if (recorder) recorder.disconnect(); } catch (e) { }
    try { if (sourceNode) sourceNode.disconnect(); } catch (e) { }
    try { if (warmupOsc) warmupOsc.stop(); } catch (e) { }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    stream = null;
    if (audioContext && audioContext.state !== 'closed') {
        try { await audioContext.close(); } catch (e) { }
    }
    audioContext = null;
    recorder = null;
    sourceNode = null;
    warmupOsc = null;
    blocks = [];
}
