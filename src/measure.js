document.getElementById('startButton').addEventListener('click', startTest);
const useThisDelayButton = document.getElementById('useThisDelayButton');
const beepDuration = 0.2;
async function startTest() {
    useThisDelayButton.style.display = 'none';
    const frequencyInput = document.getElementById('frequencyInput');
    const toneFrequency = Number.parseFloat(frequencyInput?.value);
    const testFrequency = Number.isFinite(toneFrequency) && toneFrequency > 0 ? toneFrequency : 1000;
    const resultElement = document.getElementById('result');
    const canvas = document.getElementById('waveform');
    const canvasCtx = canvas.getContext('2d');

    canvas.width = window.innerWidth * 0.8;
    canvas.height = 200;

    resultElement.textContent = 'Initializing...';

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            console.error(e);
            resultElement.textContent = 'Failed to get mic permission.';
            return;
        }
        resultElement.textContent = 'Mic permission granted.';

        const source = audioContext.createMediaStreamSource(stream);

        const bufferSize = 4096;
        const recorder = audioContext.createScriptProcessor(bufferSize, 1, 1);

        const audioData = [];

        source.connect(recorder);
        recorder.connect(audioContext.destination);

        const recordingStartTime = audioContext.currentTime;

        recorder.onaudioprocess = function (e) {
            const inputData = e.inputBuffer.getChannelData(0);
            audioData.push(new Float32Array(inputData));
        };

        resultElement.textContent = 'Recording...';

        await new Promise(resolve => setTimeout(resolve, 500));

        const oscillator = audioContext.createOscillator();
        oscillator.frequency.value = testFrequency;
        oscillator.type = 'sine';
        oscillator.connect(audioContext.destination);

        const beepPlayTime = audioContext.currentTime;

        oscillator.start();
        oscillator.stop(audioContext.currentTime + beepDuration);

        await new Promise(resolve => setTimeout(resolve, 4000));

        recorder.disconnect();
        source.disconnect();
        stream.getTracks().forEach(track => track.stop());

        let totalLength = audioData.reduce((acc, val) => acc + val.length, 0);
        let recordedAudio = new Float32Array(totalLength);
        let offset = 0;
        for (let i = 0; i < audioData.length; i++) {
            recordedAudio.set(audioData[i], offset);
            offset += audioData[i].length;
        }

        const sampleRate = audioContext.sampleRate;
        const beepStartIndex = findBeepStartIndex(recordedAudio, sampleRate);

        drawWaveform(recordedAudio, canvasCtx, canvas.width, canvas.height, {
            beepPlayTime,
            beepHeardTime: beepStartIndex !== -1 ? recordingStartTime + (beepStartIndex / sampleRate) : null,
            recordingStartTime,
            duration: recordedAudio.length / sampleRate
        }, sampleRate);

        if (beepStartIndex === -1) {
            resultElement.textContent = 'No beep detected.';
        } else {
            const beepHeardTime = recordingStartTime + (beepStartIndex / sampleRate);
            const delay = (beepHeardTime - beepPlayTime) * 1000;
            resultElement.textContent = `Measured delay: ${delay.toFixed(2)} ms`;
            useThisDelayButton.style.display = 'inline';
            useThisDelayButton.onclick = () => {
                const delayInt = Math.round(delay);
                browser.storage.sync.set({ frameDelay: delayInt });
                alert('Delay saved.');
            };
        }

    } catch (e) {
        console.error(e);
        resultElement.textContent = 'An error occurred.';
    }
}

function findBeepStartIndex(audioBuffer, sampleRate) {

    const minSilenceTime = 0.5;
    const startIndex = Math.floor(minSilenceTime * sampleRate);

    const beepDurationLength = Math.floor(beepDuration * sampleRate);
    let beepDurationSum = 0;
    let beepStart = -1;
    let maxBeepDurationSum = 0;
    for (let i = startIndex; i < startIndex + beepDurationLength; i++) {
        beepDurationSum += Math.abs(audioBuffer[i]);
    }
    const threshold = 0.02;
    for (let i = startIndex; i < audioBuffer.length; i++) {
        if (beepDurationSum > maxBeepDurationSum && audioBuffer[i] > threshold) {
            maxBeepDurationSum = beepDurationSum;
            beepStart = i;
        }
        if (i + beepDurationLength >= audioBuffer.length) {
            break;
        }
        beepDurationSum -= Math.abs(audioBuffer[i]);
        beepDurationSum += Math.abs(audioBuffer[i + beepDurationLength]);
    }
    return beepStart;
}

function drawWaveform(data, canvasCtx, width, height, times, sampleRate) {
    canvasCtx.clearRect(0, 0, width, height);

    canvasCtx.fillStyle = 'rgba(200, 200, 200, 0.5)';
    canvasCtx.fillRect(0, 0, width, height);

    canvasCtx.lineWidth = 1;
    canvasCtx.strokeStyle = 'rgb(0, 0, 0)';
    canvasCtx.beginPath();

    const sliceWidth = width / data.length;
    let x = 0;

    for (let i = 0; i < data.length; i++) {
        const v = data[i] * 0.5 + 0.5;
        const y = v * height;

        if (i === 0) {
            canvasCtx.moveTo(x, y);
        } else {
            canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    canvasCtx.stroke();

    if (times.beepPlayTime) {
        const playTimeOffset = times.beepPlayTime - times.recordingStartTime;
        const playtimeX = (playTimeOffset / times.duration) * width;

        canvasCtx.strokeStyle = 'red';
        canvasCtx.lineWidth = 2;
        canvasCtx.beginPath();
        canvasCtx.moveTo(playtimeX, 0);
        canvasCtx.lineTo(playtimeX, height);
        canvasCtx.stroke();

        canvasCtx.fillStyle = 'red';
        canvasCtx.font = '12px Arial';
        canvasCtx.fillText('Audio play', playtimeX + 5, 15);
    }

    if (times.beepHeardTime) {
        const heardTimeOffset = times.beepHeardTime - times.recordingStartTime;
        const heardTimeX = (heardTimeOffset / times.duration) * width;

        canvasCtx.strokeStyle = 'blue';
        canvasCtx.lineWidth = 2;
        canvasCtx.beginPath();
        canvasCtx.moveTo(heardTimeX, 0);
        canvasCtx.lineTo(heardTimeX, height);
        canvasCtx.stroke();

        const endTimeX = (heardTimeOffset + beepDuration) / times.duration * width;
        canvasCtx.strokeStyle = 'blue';
        canvasCtx.lineWidth = 2;
        canvasCtx.beginPath();
        canvasCtx.moveTo(endTimeX, 0);
        canvasCtx.lineTo(endTimeX, height);
        canvasCtx.stroke();

        canvasCtx.fillStyle = 'blue';
        canvasCtx.font = '12px Arial';
        canvasCtx.fillText('Audio heard', heardTimeX + 5, 30);
    }
}