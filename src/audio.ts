/**
 * AudioManager handles synthesized and managed sound effects using the Web Audio API.
 * This avoids dependency on external assets while providing low-latency feedback.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** Sub-buses under master: music and effects are mixed independently. */
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  
  // Looping engine sound
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineNoise: AudioBufferSourceNode | null = null;
  private engineLfo: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private volume = 0.8;
  private musicVolume = 0.7;
  private sfxVolume = 1;

  // Background Music Sequencer
  private musicInterval: number | null = null;
  private musicStep = 0;
  
  private lastExplosionTime = 0;
  private lastHitSoundTime = 0;
  private lastGunSoundTime = 0;
  private explosionNoiseBuffer: AudioBuffer | null = null;
  private bigExplosionNoiseBuffer: AudioBuffer | null = null;
  private shotgunNoiseBuffer: AudioBuffer | null = null;

  constructor() {
    // Context is created lazily on first interaction
  }

  private init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume * 0.5;
    this.masterGain.connect(this.ctx.destination);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.masterGain);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicVolume;
    this.musicGain.connect(this.masterGain);

    // Pre-create shared explosion noise buffers (avoids 24k Math.random() allocations on every boom)
    const noiseLen = Math.floor(this.ctx.sampleRate * 0.5);
    this.explosionNoiseBuffer = this.ctx.createBuffer(1, noiseLen, this.ctx.sampleRate);
    const exData = this.explosionNoiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      exData[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
    }

    const bigNoiseLen = Math.floor(this.ctx.sampleRate * 0.9);
    this.bigExplosionNoiseBuffer = this.ctx.createBuffer(1, bigNoiseLen, this.ctx.sampleRate);
    const bigData = this.bigExplosionNoiseBuffer.getChannelData(0);
    for (let i = 0; i < bigNoiseLen; i++) {
      bigData[i] = (Math.random() * 2 - 1) * (1 - i / bigNoiseLen);
    }

    const shotLen = Math.floor(this.ctx.sampleRate * 0.13);
    this.shotgunNoiseBuffer = this.ctx.createBuffer(1, shotLen, this.ctx.sampleRate);
    const shotData = this.shotgunNoiseBuffer.getChannelData(0);
    for (let i = 0; i < shotLen; i++) {
      shotData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / shotLen, 2.3);
    }
    
    this.setupEngine();
  }

  public resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setVolume(level: number) {
    this.volume = Math.max(0, Math.min(1, level));
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.volume * 0.5, this.ctx ? this.ctx.currentTime : 0, 0.05);
    }
  }

  public setMusicVolume(level: number) {
    this.musicVolume = Math.max(0, Math.min(1, level));
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.05);
    }
  }

  public setSfxVolume(level: number) {
    this.sfxVolume = Math.max(0, Math.min(1, level));
    if (this.sfxGain && this.ctx) {
      this.sfxGain.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.05);
    }
  }

  private setupEngine() {
    if (!this.ctx || !this.masterGain) return;

    // Sub-bass carrier for weight (chopping sound)
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'triangle';
    this.engineOsc.frequency.value = 38;
    
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0.14;

    // Secondary mid-bass hum carrier (turbine hum)
    this.engineOsc2 = this.ctx.createOscillator();
    this.engineOsc2.type = 'triangle';
    this.engineOsc2.frequency.value = 76;
    
    const oscGain2 = this.ctx.createGain();
    oscGain2.gain.value = 0.08;

    // Noise for rotor air movement (pre-rendered looping buffer — avoids deprecated ScriptProcessorNode)
    const noiseBufferSize = Math.floor(this.ctx.sampleRate * 2); // 2 second loop
    const noiseBuffer = this.ctx.createBuffer(1, noiseBufferSize, this.ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseBufferSize; i++) {
      noiseData[i] = Math.random() * 2 - 1;
    }
    const noiseNode = this.ctx.createBufferSource();
    noiseNode.buffer = noiseBuffer;
    noiseNode.loop = true;
    this.engineNoise = noiseNode;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 350;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.07;

    // LFO for rotor RPM effect (pulsing)
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 6.0; // 6 pulses per second base
    
    // Pitch modulation for engineOsc (gives cyclic Doppler blade pitch sweep!)
    const lfoPitchGain = this.ctx.createGain();
    lfoPitchGain.gain.value = 5.0;
    lfo.connect(lfoPitchGain);
    lfoPitchGain.connect(this.engineOsc.frequency);

    // Pitch modulation for engineOsc2
    const lfoPitchGain2 = this.ctx.createGain();
    lfoPitchGain2.gain.value = 3.0;
    lfo.connect(lfoPitchGain2);
    lfoPitchGain2.connect(this.engineOsc2.frequency);

    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.06;
    lfo.connect(lfoGain);
    
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0; // Start silent

    lfoGain.connect(this.engineGain.gain);

    this.engineOsc.connect(oscGain);
    oscGain.connect(this.engineGain);

    this.engineOsc2.connect(oscGain2);
    oscGain2.connect(this.engineGain);
    
    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.engineGain);

    this.engineGain.connect(this.sfxGain);

    this.engineOsc.start();
    this.engineOsc2.start();
    this.engineLfo = lfo;
    noiseNode.start();
    lfo.start();
  }

  public updateEngine(speedFactor: number, altitude: number) {
    if (!this.engineOsc || !this.engineOsc2 || !this.engineGain || !this.engineLfo || !this.ctx) return;
    
    // Pitch scales with speed (load)
    const pitch1 = 38 + (speedFactor * 16);
    const pitch2 = 76 + (speedFactor * 32);
    this.engineOsc.frequency.setTargetAtTime(pitch1, this.ctx.currentTime, 0.1);
    this.engineOsc2.frequency.setTargetAtTime(pitch2, this.ctx.currentTime, 0.1);

    // LFO frequency (rotor spin rate) increases dynamically under load
    const lfoSpeed = 6.0 + (speedFactor * 3.0);
    this.engineLfo.frequency.setTargetAtTime(lfoSpeed, this.ctx.currentTime, 0.12);
    
    // Volume scales up as speed increases
    const targetVol = 0.14 + (speedFactor * 0.12);
    this.engineGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.15);
  }

  public playLaser(x: number) {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'square';
    osc.frequency.setValueAtTime(400 + (Math.random() * 100), now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);
    
    g.gain.setValueAtTime(0.2, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    
    // Panning based on screen position (crude)
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, x / (window.innerWidth / 2)));

    osc.connect(g);
    g.connect(panner);
    panner.connect(this.sfxGain);
    
    osc.start();
    osc.stop(now + 0.1);
  }

  public playMachineGun(x: number) {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    if (now - this.lastGunSoundTime < 0.04) return;
    this.lastGunSoundTime = now;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();

    osc.type = 'square';
    osc.frequency.setValueAtTime(720 + Math.random() * 90, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.045);
    filter.type = 'bandpass';
    filter.frequency.value = 950;
    filter.Q.value = 3.8;
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.055);
    panner.pan.value = Math.max(-1, Math.min(1, x / 170));

    osc.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  public playShotgun(x: number) {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    const burst = this.ctx.createBufferSource();
    if (this.shotgunNoiseBuffer) {
      burst.buffer = this.shotgunNoiseBuffer;
    }
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + 0.12);
    g.gain.setValueAtTime(0.38, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
    panner.pan.value = Math.max(-1, Math.min(1, x / 170));

    burst.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(this.sfxGain);
    burst.start(now);
  }

  public playMissileLaunch() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(92, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.22);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(520, now);
    filter.frequency.exponentialRampToValueAtTime(2200, now + 0.2);
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.26);

    osc.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  public playRocketLaunch() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.exponentialRampToValueAtTime(62, now + 0.18);
    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  public playReload() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const start = now + i * 0.08;
      osc.type = 'square';
      osc.frequency.setValueAtTime(260 + i * 90, start);
      g.gain.setValueAtTime(0.12, start);
      g.gain.exponentialRampToValueAtTime(0.01, start + 0.055);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(start);
      osc.stop(start + 0.06);
    }
  }

  public playPickup() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(1040, now + 0.11);
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.16);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  public playEnemySpawn() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(68, now + 0.22);
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.24);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  public playEnemyFire() {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.2);
    
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start();
    osc.stop(now + 0.2);
  }

  public playExplosion(intensity: number = 1.0) {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    if (now - this.lastExplosionTime < 0.08) return;
    this.lastExplosionTime = now;
    
    // Use pre-allocated shared noise buffer if available
    if (this.explosionNoiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.explosionNoiseBuffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800 * intensity, now);
      filter.frequency.exponentialRampToValueAtTime(40, now + 0.4);
      
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.4 * intensity, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      
      noise.connect(filter);
      filter.connect(g);
      g.connect(this.sfxGain);
      noise.start();
    }
    
    // Low thump
    const osc = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(60 * intensity, now);
    osc.frequency.exponentialRampToValueAtTime(10, now + 0.3);
    g2.gain.setValueAtTime(0.5 * intensity, now);
    g2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    
    osc.connect(g2);
    g2.connect(this.sfxGain);
    osc.start();
    osc.stop(now + 0.3);

    // Debris crackle — throttled
    this.playCrackle(now + 0.08, Math.min(1.2, 0.4 + intensity * 0.5), 0.05 * intensity);
  }

  /** Short random crackle of bright ticks — debris hitting ground/metal. */
  private playCrackle(start: number, count: number, volume: number) {
    if (!this.ctx || !this.masterGain) return;
    for (let i = 0; i < count; i++) {
      const t = start + Math.random() * 0.4;
      const osc = this.ctx.createOscillator();
      const cg = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(180 + Math.random() * 900, t);
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.exponentialRampToValueAtTime(Math.max(0.005, volume), t + 0.006);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.05);
      osc.connect(cg);
      cg.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.12);
    }
  }

  /** Big layered explosion for player death / major building collapse —
   *  longer sub thump, wider noise, and a heavier debris crackle. */
  public playBigExplosion(intensity: number = 1.5) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    if (this.bigExplosionNoiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.bigExplosionNoiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1500 * intensity, now);
      filter.frequency.exponentialRampToValueAtTime(50, now + 0.7);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.6 * intensity, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
      noise.connect(filter);
      filter.connect(g);
      g.connect(this.sfxGain);
      noise.start();
    }

    // Deep sub thump — the big body of the boom
    const osc = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(70 * intensity, now);
    osc.frequency.exponentialRampToValueAtTime(12, now + 0.5);
    g2.gain.setValueAtTime(0.8 * intensity, now);
    g2.gain.exponentialRampToValueAtTime(0.01, now + 0.55);
    osc.connect(g2);
    g2.connect(this.sfxGain);
    osc.start();
    osc.stop(now + 0.55);

    // Second delayed mid punch for a layered feel
    const osc2 = this.ctx.createOscillator();
    const g3 = this.ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(110 * intensity, now + 0.05);
    osc2.frequency.exponentialRampToValueAtTime(30, now + 0.35);
    g3.gain.setValueAtTime(0.001, now + 0.05);
    g3.gain.exponentialRampToValueAtTime(0.4 * intensity, now + 0.09);
    g3.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc2.connect(g3);
    g3.connect(this.sfxGain);
    osc2.start(now + 0.05);
    osc2.stop(now + 0.4);

    // Heavy debris rain
    this.playCrackle(now + 0.12, 2.2, 0.1 * intensity);
  }

  public playHonk() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    // Classic two-tone car horn — dual saws a minor third apart, ~0.35s
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.linearRampToValueAtTime(430, now + 0.04);
    osc.frequency.setValueAtTime(430, now + 0.2);
    osc.frequency.linearRampToValueAtTime(370, now + 0.3);
    osc2.frequency.setValueAtTime(286, now);
    osc2.frequency.linearRampToValueAtTime(362, now + 0.04);
    osc2.frequency.setValueAtTime(362, now + 0.2);
    osc2.frequency.linearRampToValueAtTime(310, now + 0.3);
    filter.type = 'lowpass';
    filter.frequency.value = 2200;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.11, now + 0.03);
    g.gain.setValueAtTime(0.11, now + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.34);
    osc2.start(now);
    osc2.stop(now + 0.34);
  }

  public playHit() {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    if (now - this.lastHitSoundTime < 0.035) return; // Throttle hits
    this.lastHitSoundTime = now;
    
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.linearRampToValueAtTime(200, now + 0.05);
    
    g.gain.setValueAtTime(0.1, now);
    g.gain.linearRampToValueAtTime(0, now + 0.05);
    
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start();
    osc.stop(now + 0.05);
  }

  public playLockBeep() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, now);
    
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.075);
    
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  public playSamLockBeep(progress: number) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 720 + Math.max(0, Math.min(1, progress)) * 520;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.075);
  }

  public playSamMissileLaunch() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(95, now);
    osc.frequency.exponentialRampToValueAtTime(310, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.36);
  }

  public playKillCombo(tier: number) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const base = 440 + tier * 160;
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = base * (1 + i * 0.25);
      g.gain.setValueAtTime(0.0001, now + i * 0.06);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.06 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.06 + 0.12);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.14);
    }
  }

  public playUpgrade() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.16, now + i * 0.07 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.3);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(now + i * 0.07);
      osc.stop(now + i * 0.07 + 0.32);
    });
  }

  public startMusic() {
    if (this.musicInterval) return;
    this.resume();
    this.musicStep = 0;
    this.musicInterval = window.setInterval(this.musicTick, 115);
  }

  public stopMusic() {
    if (this.musicInterval) {
      window.clearInterval(this.musicInterval);
      this.musicInterval = null;
    }
  }

  private musicTick = () => {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    
    // Bass note conversion (MIDI)
    const bassMidi = [40, 40, 40, 40, 43, 43, 45, 45, 40, 40, 40, 40, 38, 38, 35, 37][this.musicStep % 16];
    if (bassMidi > 0) {
      const freq = 440 * Math.pow(2, (bassMidi - 69) / 12);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(180, now);
      
      g.gain.setValueAtTime(0.05, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.musicGain);
      
      osc.start(now);
      osc.stop(now + 0.2);
    }
    
    // Lead melody note conversion
    const melodyMidi = [
      64, 0, 67, 0, 69, 0, 71, 72, 71, 0, 69, 0, 67, 0, 64, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      64, 67, 69, 71, 72, 74, 76, 0, 76, 74, 72, 71, 69, 67, 64, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ][this.musicStep % 64];
    
    if (melodyMidi > 0) {
      const freq = 440 * Math.pow(2, (melodyMidi - 69) / 12);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      
      g.gain.setValueAtTime(0.035, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      
      osc.connect(g);
      g.connect(this.musicGain);
      
      osc.start(now);
      osc.stop(now + 0.3);
    }
    
    this.musicStep++;
  };

  private tacticalTone(startHz: number, endHz: number, duration: number, volume = 0.12) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(startHz, now);
    osc.frequency.exponentialRampToValueAtTime(endHz, now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + duration);
  }

  public playCountermeasure() { this.tacticalTone(760, 180, 0.16, 0.16); }
  public playLockBreak() { this.tacticalTone(420, 980, 0.18, 0.1); }
  public playThreatLevel() { this.tacticalTone(240, 520, 0.24, 0.11); }

  // ── UI & feedback cues ─────────────────────────────────────────────
  // Short synthesized stingers for menus and gameplay readiness. All of them
  // resume the context first so the very first menu click can make sound.

  /** Crisp menu button click. */
  public playClick() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.05);
    g.gain.setValueAtTime(0.09, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  /** Subtle tactical blip on menu item hover / navigation focus. */
  public playHover() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, now);
    osc.frequency.exponentialRampToValueAtTime(840, now + 0.025);
    g.gain.setValueAtTime(0.025, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  /** Coin chime for purchases and credit rewards. */
  public playPurchase() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const notes = [988, 1319];
    notes.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.1, now + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.16);
      osc.connect(g);
      g.connect(this.sfxGain!);
      osc.start(now + i * 0.07);
      osc.stop(now + i * 0.07 + 0.18);
    });
  }

  /** Low double-buzz for rejected actions (not enough credits, locked item). */
  public playError() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, now + i * 0.09);
      osc.frequency.exponentialRampToValueAtTime(92, now + i * 0.09 + 0.08);
      g.gain.setValueAtTime(0.07, now + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.08);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.09);
    }
  }

  /** Rising fanfare for a new personal best. */
  public playNewBest() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.11, now + i * 0.08 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.3);
      osc.connect(g);
      g.connect(this.sfxGain!);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.32);
    });
  }

  /** Two-tone alarm for low hull / low fuel. */
  public playWarning() {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    [660, 494].forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.13, now + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.13);
      osc.connect(g);
      g.connect(this.sfxGain!);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.15);
    });
  }

  /** Short rising blip — a system just came back online (flares/salvo/super). */
  public playReady() {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, now);
    osc.frequency.exponentialRampToValueAtTime(1240, now + 0.09);
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.13);
  }

  /** Wave start — descending tension tone. */
  public playWaveStart() {
    if (!this.ctx || !this.sfxGain) return;
    this.tacticalTone(520, 220, 0.3, 0.1);
  }

  /** Wave cleared — bright rising triad. */
  public playWaveComplete() {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    [392, 523, 659].forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + i * 0.06);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.06 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.06 + 0.24);
      osc.connect(g);
      g.connect(this.sfxGain!);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.26);
    });
  }

  /** Boss 3-stage intro audio sequence (sub-bass drop + ominous alarm + arrival chord). */
  public playBossIntro(stage: number) {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    if (stage === 1) {
      // Sub-bass drop + warning siren
      const subOsc = this.ctx.createOscillator();
      const subGain = this.ctx.createGain();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(140, now);
      subOsc.frequency.exponentialRampToValueAtTime(36, now + 0.65);
      subGain.gain.setValueAtTime(0.22, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
      subOsc.connect(subGain);
      subGain.connect(this.sfxGain);
      subOsc.start(now);
      subOsc.stop(now + 0.72);

      // Warning siren pulses
      for (let i = 0; i < 2; i++) {
        const siren = this.ctx.createOscillator();
        const sirenGain = this.ctx.createGain();
        siren.type = 'sawtooth';
        siren.frequency.setValueAtTime(440, now + i * 0.28);
        siren.frequency.linearRampToValueAtTime(330, now + i * 0.28 + 0.22);
        sirenGain.gain.setValueAtTime(0.1, now + i * 0.28);
        sirenGain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.28 + 0.24);
        siren.connect(sirenGain);
        sirenGain.connect(this.sfxGain);
        siren.start(now + i * 0.28);
        siren.stop(now + i * 0.28 + 0.25);
      }
    } else if (stage === 2) {
      // Tech telemetry chirp + threat ping
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(580, now);
      osc.frequency.setValueAtTime(880, now + 0.08);
      g.gain.setValueAtTime(0.12, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.26);
    } else {
      // Heavy engine arrival power chord (low rumbling brass chord)
      [55, 110, 165].forEach((freq) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.15, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
        osc.connect(g);
        g.connect(this.sfxGain!);
        osc.start(now);
        osc.stop(now + 0.9);
      });
    }
  }

  /** Rising strobe charging tone telegraphing boss Rocket Spread Salvo. */
  public playRocketCharge() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(840, now + 0.65);

    // Strobe AM modulation
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.setValueAtTime(8, now);
    lfo.frequency.linearRampToValueAtTime(24, now + 0.65);
    lfoGain.gain.value = 0.07;
    lfo.connect(g.gain);

    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

    osc.connect(g);
    g.connect(this.sfxGain);

    lfo.start(now);
    lfo.stop(now + 0.72);
    osc.start(now);
    osc.stop(now + 0.72);
  }

  /** High-pitched Combat Drone jet/turbine whine flyby sound. */
  public playDroneFlyby(dist: number = 40) {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    const volume = Math.max(0.02, Math.min(0.08, 1.0 - dist / 90));
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(820, now);
    osc.frequency.linearRampToValueAtTime(640, now + 0.28);
    g.gain.setValueAtTime(volume, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  /** Distinctive 2-round mechanical kinetic pulse 'PA-PA' for Combat Drones. */
  public playDronePulseFire() {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(420, now + i * 0.09);
      osc.frequency.exponentialRampToValueAtTime(180, now + i * 0.09 + 0.06);
      g.gain.setValueAtTime(0.09, now + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.07);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.08);
    }
  }

  /** Structural collapse audio for Radar Station: impact explosion -> metal groan -> deep thud. */
  public playRadarDestruction() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    // Initial blast
    this.playExplosion(1.4);

    // Deep metallic structural groan
    const groanOsc = this.ctx.createOscillator();
    const groanGain = this.ctx.createGain();
    groanOsc.type = 'sawtooth';
    groanOsc.frequency.setValueAtTime(95, now + 0.1);
    groanOsc.frequency.linearRampToValueAtTime(42, now + 0.55);
    groanGain.gain.setValueAtTime(0.18, now + 0.1);
    groanGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    groanOsc.connect(groanGain);
    groanGain.connect(this.sfxGain);
    groanOsc.start(now + 0.1);
    groanOsc.stop(now + 0.62);

    // Deep structural collapsing thud
    const thudOsc = this.ctx.createOscillator();
    const thudGain = this.ctx.createGain();
    thudOsc.type = 'sine';
    thudOsc.frequency.setValueAtTime(75, now + 0.35);
    thudOsc.frequency.exponentialRampToValueAtTime(25, now + 0.85);
    thudGain.gain.setValueAtTime(0.25, now + 0.35);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    thudOsc.connect(thudGain);
    thudGain.connect(this.sfxGain);
    thudOsc.start(now + 0.35);
    thudOsc.stop(now + 0.92);
  }

  /**
   * Supersonic near-miss projectile whoosh / whip-crack with directional panning.
   * Triggered when high-danger projectile grazes the player's proximity bubble.
   */
  public playNearMiss(pan: number = 0) {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1450, now);
    osc.frequency.exponentialRampToValueAtTime(280, now + 0.12);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.frequency.exponentialRampToValueAtTime(450, now + 0.12);
    filter.Q.value = 4.5;

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

    panner.pan.value = Math.max(-1, Math.min(1, pan));

    osc.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(this.sfxGain);

    osc.start(now);
    osc.stop(now + 0.14);
  }

  /**
   * High-speed aircraft fly-by whoosh with Doppler pitch shift.
   */
  public playFlyby(speed: number = 40, pan: number = 0) {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();

    const startFreq = 880 + Math.min(speed * 4, 400);
    const endFreq = 260;

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.28);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, now);
    filter.frequency.exponentialRampToValueAtTime(600, now + 0.28);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.14, now + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);

    panner.pan.value = Math.max(-1, Math.min(1, pan));

    osc.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(this.sfxGain);

    osc.start(now);
    osc.stop(now + 0.32);
  }

  /** Heavy deep tank cannon shot distinct from light vehicle fire. */
  public playTankCannon(pan: number = 0) {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.25);

    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    panner.pan.value = Math.max(-1, Math.min(1, pan));

    osc.connect(g);
    g.connect(panner);
    panner.connect(this.sfxGain);

    osc.start(now);
    osc.stop(now + 0.30);
  }

  /** Secondary missile propellant cook-off for SAM site destruction. */
  public playSamCookOff() {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    for (let i = 0; i < 3; i++) {
      const t = now + 0.08 + i * 0.12 + Math.random() * 0.05;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(260 + Math.random() * 200, t);
      osc.frequency.exponentialRampToValueAtTime(80, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.11);
    }
  }

  /** Electromagnetic pulse discharge sound for EMP power-up / disruption. */
  public playEmpPulse() {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.45);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.linearRampToValueAtTime(2400, now + 0.2);
    filter.frequency.exponentialRampToValueAtTime(200, now + 0.5);
    filter.Q.value = 6.0;

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.22, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.52);

    osc.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);

    osc.start(now);
    osc.stop(now + 0.55);
  }

  /** Air enemy death spiral stalling turbine flutter / screaming pitch drop. */
  public playAirDeathSpiral() {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(540, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.65);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.11, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.70);

    osc.connect(g);
    g.connect(this.sfxGain);

    osc.start(now);
    osc.stop(now + 0.72);
  }

  /**
   * Crisp synthesized audio stings for temporary power-ups.
   */
  public playPowerUpSting(name: string) {
    this.resume();
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    switch (name) {
      case 'OVERDRIVE': {
        const notes = [440, 554, 659, 880];
        notes.forEach((f, i) => {
          const osc = this.ctx!.createOscillator();
          const g = this.ctx!.createGain();
          osc.type = 'sawtooth';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.0001, now + i * 0.05);
          g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.05 + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.05 + 0.18);
          osc.connect(g);
          g.connect(this.sfxGain!);
          osc.start(now + i * 0.05);
          osc.stop(now + i * 0.05 + 0.20);
        });
        break;
      }
      case 'MAGNET_SURGE': {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.linearRampToValueAtTime(1280, now + 0.22);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.14, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.connect(g);
        g.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.26);
        break;
      }
      case 'FIELD_REPAIR': {
        const notes = [523, 659, 784];
        notes.forEach((f, i) => {
          const osc = this.ctx!.createOscillator();
          const g = this.ctx!.createGain();
          osc.type = 'triangle';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.0001, now + i * 0.07);
          g.gain.exponentialRampToValueAtTime(0.15, now + i * 0.07 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.22);
          osc.connect(g);
          g.connect(this.sfxGain!);
          osc.start(now + i * 0.07);
          osc.stop(now + i * 0.07 + 0.24);
        });
        break;
      }
      case 'EMP_PULSE':
        this.playEmpPulse();
        break;
      case 'SALVAGE_CACHE': {
        const notes = [659, 880, 1174];
        notes.forEach((f, i) => {
          const osc = this.ctx!.createOscillator();
          const g = this.ctx!.createGain();
          osc.type = 'square';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.0001, now + i * 0.06);
          g.gain.exponentialRampToValueAtTime(0.11, now + i * 0.06 + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.06 + 0.24);
          osc.connect(g);
          g.connect(this.sfxGain!);
          osc.start(now + i * 0.06);
          osc.stop(now + i * 0.06 + 0.26);
        });
        break;
      }
      default:
        this.playPickup();
        break;
    }
  }

  public dispose() {
    this.stopMusic();

    if (this.engineOsc) {
      this.engineOsc.stop();
      this.engineOsc.disconnect();
      this.engineOsc = null;
    }

    if (this.engineOsc2) {
      this.engineOsc2.stop();
      this.engineOsc2.disconnect();
      this.engineOsc2 = null;
    }

    if (this.engineLfo) {
      this.engineLfo.stop();
      this.engineLfo.disconnect();
      this.engineLfo = null;
    }

    if (this.engineNoise) {
      try {
        this.engineNoise.stop();
      } catch {
        // Already stopped
      }
      this.engineNoise.disconnect();
      this.engineNoise = null;
    }

    this.engineGain?.disconnect();
    this.engineGain = null;
    this.sfxGain?.disconnect();
    this.sfxGain = null;
    this.musicGain?.disconnect();
    this.musicGain = null;
    this.masterGain?.disconnect();
    this.masterGain = null;

    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
