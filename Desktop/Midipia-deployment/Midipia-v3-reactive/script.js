// ==========================================
// 1. STAGE SETUP & ROBUST SELECTORS
// ==========================================
// Using querySelector so it doesn't crash if an ID is missing!
const highway = document.querySelector('.highway');
const debugLog = document.getElementById('debug-log') || { innerText: '' };
const scoreDisplay = document.getElementById('score') || { innerText: '' };
const strikeZoneEl = document.getElementById('strike-zone');
const speedSlider = document.getElementById('speed-slider');
const speedDisplay = document.getElementById('speed-display');

let score = 0;
let playbackSpeed = 1.0;
let songTimeouts = [];
const FALL_TIME_BASE = 2.5;

// Clean out any old hardcoded lanes from the HTML
highway.querySelectorAll('.lane').forEach(lane => lane.remove());

// --- SPEED SLIDER LOGIC ---
if (speedSlider) {
    speedSlider.addEventListener('input', (e) => {
        playbackSpeed = parseFloat(e.target.value);
        if(speedDisplay) speedDisplay.innerText = playbackSpeed.toFixed(1);
    });
}

// ==========================================
// 2. THE 49-KEY GENERATOR (C2 to C6)
// ==========================================
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const laneMap = {}; 

for (let midiNote = 36; midiNote <= 84; midiNote++) {
    const lane = document.createElement('div');
    const noteName = noteNames[midiNote % 12];
    const isBlackKey = noteName.includes('#');

    lane.className = `lane ${isBlackKey ? 'black-key' : 'white-key'}`;
    lane.id = `lane-${midiNote}`;
    lane.innerText = isBlackKey ? '' : noteName; 

    highway.appendChild(lane);
    laneMap[midiNote] = lane.id;
}

// --- VERSION 3: Reactive (Aftertouch Breathing) ---
// Usamos el Aftertouch para controlar la saturación y brillo (el "respiro").

function applyBreathingEffect(pressure) {
    const intensity = (pressure / 127) * 100; // 0-100%
    document.body.style.filter = `brightness(${50 + intensity}%) saturate(${intensity}%)`;
}

// ==========================================
// 3. CLAUDE'S AWESOME REVERB SYNTHESIZER
// ==========================================
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
const activeNotes = {};
let dryGain, wetGain, convolverNode;

// Reverb Setup
function createReverbConvolver() {
    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    convolverNode = audioCtx.createConvolver();
    const rate = audioCtx.sampleRate;
    const length = rate * 2;
    const impulse = audioCtx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
        left[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
        right[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
    }
    convolverNode.buffer = impulse;
    dryGain.connect(audioCtx.destination);
    wetGain.connect(convolverNode);
    convolverNode.connect(audioCtx.destination);
    dryGain.gain.value = 0.7;
    wetGain.gain.value = 0.3;
}
createReverbConvolver();

// Delay Setup
const delayNode = audioCtx.createDelay();
const delayGain = audioCtx.createGain();
delayNode.delayTime.value = 0.35;
delayGain.gain.value = 0.2;
delayNode.connect(delayGain);
delayGain.connect(delayNode);
delayGain.connect(audioCtx.destination);

function midiToFreq(note) { return 440 * Math.pow(2, (note - 69) / 12); }

function playSynth(note, velocity) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const baseGain = audioCtx.createGain();
    const velocityFactor = (velocity / 127) * 0.2;
    const fundamentalFreq = midiToFreq(note);

    const fundamental = audioCtx.createOscillator();
    fundamental.type = 'sine';
    fundamental.frequency.value = fundamentalFreq;
    const fund1Gain = audioCtx.createGain();
    fund1Gain.gain.value = 0.6;
    fundamental.connect(fund1Gain);
    fund1Gain.connect(baseGain);

    const harmonic2 = audioCtx.createOscillator();
    harmonic2.type = 'sine';
    harmonic2.frequency.value = fundamentalFreq * 2;
    const harm2Gain = audioCtx.createGain();
    harm2Gain.gain.value = 0.2;
    harmonic2.connect(harm2Gain);
    harm2Gain.connect(baseGain);

    baseGain.gain.value = velocityFactor;
    baseGain.connect(dryGain);
    baseGain.connect(wetGain);
    baseGain.connect(delayNode);

    baseGain.gain.setTargetAtTime(velocityFactor * 0.7, audioCtx.currentTime, 0.15);
    fundamental.start();
    harmonic2.start();

    activeNotes[note] = { oscillators: [fundamental, harmonic2], baseGain };
}

function stopSynth(note) {
    if (activeNotes[note]) {
        const { oscillators, baseGain } = activeNotes[note];
        baseGain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.2);
        oscillators.forEach(osc => osc.stop(audioCtx.currentTime + 0.2));
        delete activeNotes[note];
    }
}

// ==========================================
// 4. HARDWARE CONNECTION & GAME LOGIC
// ==========================================
if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(onMIDISuccess, () => debugLog.innerText = "MIDI Blocked.");
}

function onMIDISuccess(midiAccess) {
    debugLog.innerText = "SUCCESS: MIDI Connected!";
    debugLog.style.color = "#0ff";
    for (let input of midiAccess.inputs.values()) { input.onmidimessage = getMIDIMessage; }
}

function getMIDIMessage(message) {
    const command = message.data[0];
    const note = message.data[1];
    const velocity = message.data[2];

    if (command === 144 && velocity > 0) {
        playSynth(note, velocity);
        checkCollision(laneMap[note]); 
    } else if (command === 128 || (command === 144 && velocity === 0)) {
        stopSynth(note);
    }
}

function checkCollision(laneId) {
    if (!laneId) return; 
    
    const lane = document.getElementById(laneId);
    const notesInLane = lane.getElementsByClassName('note');
    const strikeRect = strikeZoneEl.getBoundingClientRect();
    let hitSuccess = false;

    for (let i = 0; i < notesInLane.length; i++) {
        const noteEl = notesInLane[i];
        const noteRect = noteEl.getBoundingClientRect();
        if (noteRect.bottom >= strikeRect.top && noteRect.top <= strikeRect.bottom) {
            hitSuccess = true;
            gsap.killTweensOf(noteEl);
            noteEl.remove();
            break; 
        }
    }

    if (hitSuccess) {
        gsap.fromTo(lane, { backgroundColor: "rgba(0, 255, 255, 0.8)" }, { backgroundColor: "transparent", duration: 0.3 });
        score += 50;
        scoreDisplay.innerText = score;
    } else {
        gsap.fromTo(lane, { backgroundColor: "rgba(255, 0, 0, 0.4)" }, { backgroundColor: "transparent", duration: 0.3 });
        score = Math.max(0, score - 10);
        scoreDisplay.innerText = score;
    }
}

// ==========================================
// 5. RESTORING CLAUDE'S BUILT-IN SONGS
// ==========================================
const songs = {
    'twinkle': {
        title: 'Twinkle Twinkle',
        notes: [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60],
        timing: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 4.5, 5, 5.5, 6, 6.5, 7]
    },
    'mary': {
        title: 'Mary Had a Lamb',
        notes: [64, 62, 60, 62, 64, 64, 64, 62, 62, 62, 64, 67, 69],
        timing: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 4.5, 5, 5.5, 6, 7]
    },
    'ode': {
        title: 'Ode to Joy',
        notes: [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 64, 64],
        timing: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 5.5, 6, 6.5, 7, 7.5, 8]
    }
};

window.playSong = function(songKey) {
    const song = songs[songKey];
    if (!song) return;

    songTimeouts.forEach(clearTimeout);
    songTimeouts = [];
    score = 0;
    scoreDisplay.innerText = score;
    debugLog.innerText = `Now Playing: ${song.title}`;

    song.notes.forEach((midiNote, index) => {
        // Speed slider affects the wait time!
        const delayMs = (song.timing[index] / playbackSpeed) * 1000;
        const timeout = setTimeout(() => {
            spawnNoteBlock(midiNote, 0.4); // 0.4s duration for basic song dots
        }, delayMs);
        songTimeouts.push(timeout);
    });
};

// ==========================================
// 6. NEW MIDI FILE UPLOADER
// ==========================================
const midiUploadBtn = document.getElementById('midi-upload');
if (midiUploadBtn) {
    midiUploadBtn.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            // Requires the Tone.js Midi script to be in HTML!
            if (typeof Midi === 'undefined') {
                debugLog.innerText = "Error: Tone.js Midi library not loaded in HTML!";
                return;
            }
            const midiData = new Midi(e.target.result);
            debugLog.innerText = `Loaded: ${file.name}. Here we go!`;
            
            const track = midiData.tracks.find(t => t.notes.length > 0);
            if (track) {
                songTimeouts.forEach(clearTimeout);
                songTimeouts = [];
                score = 0;
                scoreDisplay.innerText = score;

                track.notes.forEach(note => {
                    const spawnTimeMs = (note.time / playbackSpeed) * 1000;
                    const timeout = setTimeout(() => {
                        spawnNoteBlock(note.midi, note.duration);
                    }, spawnTimeMs);
                    songTimeouts.push(timeout);
                });
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

// ==========================================
// 7. THE ANIMATION ENGINE (GSAP)
// ==========================================
function spawnNoteBlock(midiNote, durationInSeconds) {
    const laneId = laneMap[midiNote];
    if (!laneId) return; 

    const lane = document.getElementById(laneId);
    if(!lane) return;

    const noteElement = document.createElement('div');
    noteElement.classList.add('note');
    
    // NUEVO: Extraemos el nombre de la nota y se lo asignamos al texto del bloque
    const noteName = noteNames[midiNote % 12];
    noteElement.innerText = noteName;
    
    // VISUAL DURATION: Speed slider stretches/shrinks the note height!
    const adjustedDuration = durationInSeconds / playbackSpeed;
    const heightPx = Math.max(15, adjustedDuration * 150); 
    noteElement.style.height = `${heightPx}px`;
    noteElement.style.top = `-${heightPx}px`; 

    lane.appendChild(noteElement);

    const travelDuration = FALL_TIME_BASE / playbackSpeed;

    gsap.to(noteElement, { 
        top: "100%", 
        duration: travelDuration, 
        ease: "none", 
        onComplete: () => {
            if (noteElement.parentNode) noteElement.remove();
        }
    });
}

// Unlock audio on iPad tap
document.body.addEventListener('touchstart', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });
document.body.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });