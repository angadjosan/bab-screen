"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./NoiseMeter.module.css";

/**
 * Room noise meter. Listens to the default microphone, measures the level in
 * the browser, and shows an estimated sound level. Audio never leaves the
 * page: nothing is recorded, stored or sent anywhere.
 */

/**
 * Added to the measured level (A-weighted dBFS, i.e. dB relative to digital
 * full scale) to turn it into an ESTIMATED sound pressure level.
 *
 * A browser cannot know a microphone's sensitivity or the input gain set in
 * macOS, so this number is a guess for a MacBook's built-in mic and the
 * reading can easily be 10 dB out until it is calibrated. To calibrate: put a
 * phone running an SPL meter app (A-weighted, slow response) next to the
 * MacBook, play steady noise in the room, and add (phone reading - this
 * meter's reading) to this constant. Changing the macOS input volume or the
 * microphone afterwards invalidates the calibration.
 */
const CALIBRATION_OFFSET_DB = 100;

/** Readings are clamped to this range; outside it the estimate is meaningless. */
const MIN_DB = 20;
const MAX_DB = 120;

/** Thresholds for the quiet / moderate / loud colouring. */
const MODERATE_DB = 55;
const LOUD_DB = 70;

/** Range drawn by the history bars and the level bar. */
const SCALE_MIN_DB = 30;
const SCALE_MAX_DB = 90;

const TICK_MS = 40; // one analyser block (2048 samples) is ~43 ms at 48 kHz
const FAST_TAU_S = 0.125; // sound-level-meter "fast" response, drives the bar
const SLOW_TAU_S = 1; // "slow" response, drives the number
const UI_INTERVAL_MS = 320;
const HISTORY_SECONDS = 60;
const SILENCE_POWER = 1e-12; // -120 dBFS: below any real microphone's noise
const SILENCE_AFTER_S = 5;
const RETRY_MS = 10_000;

type Level = "quiet" | "moderate" | "loud";
type Status =
  | { kind: "requesting" }
  | { kind: "running" }
  | { kind: "suspended" }
  | { kind: "silent" }
  | { kind: "error"; message: string };

const levelOf = (db: number): Level => (db >= LOUD_DB ? "loud" : db >= MODERATE_DB ? "moderate" : "quiet");
const LEVEL_LABEL: Record<Level, string> = { quiet: "Quiet", moderate: "Moderate", loud: "Loud" };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const toDbfs = (meanSquare: number) => 10 * Math.log10(Math.max(meanSquare, 1e-20));
const toSpl = (meanSquare: number) => clamp(toDbfs(meanSquare) + CALIBRATION_OFFSET_DB, MIN_DB, MAX_DB);
const scaleFraction = (db: number) => clamp((db - SCALE_MIN_DB) / (SCALE_MAX_DB - SCALE_MIN_DB), 0, 1);

/**
 * A-weighting (IEC 61672) as three biquads. The analogue curve has a double
 * pole at 20.6 Hz, single poles at 107.7 Hz and 737.9 Hz, a double pole at
 * 12194 Hz and four zeros at 0 Hz, which is exactly: a 2nd-order highpass at
 * 20.6 Hz with Q 0.5, a 2nd-order highpass whose two real poles are 107.7 and
 * 737.9 Hz (f0 = their geometric mean, Q = f0 / their sum), and a 2nd-order
 * lowpass at 12194 Hz with Q 0.5. Web Audio takes Q for these types in dB.
 * The gain is then set so the response at 1 kHz is 0 dB.
 */
function connectAWeighting(ctx: AudioContext, source: AudioNode): AudioNode {
  const qDb = (q: number) => 20 * Math.log10(q);
  const f2 = 107.65265;
  const f3 = 737.86223;
  const specs: Array<[BiquadFilterType, number, number]> = [
    ["highpass", 20.598997, 0.5],
    ["highpass", Math.sqrt(f2 * f3), Math.sqrt(f2 * f3) / (f2 + f3)],
  ];
  // The lowpass corner must sit below Nyquist; skip it on very low sample rates.
  if (ctx.sampleRate / 2 > 12194.217 * 1.2) specs.push(["lowpass", 12194.217, 0.5]);

  const at1k = new Float32Array([1000]);
  const mag = new Float32Array(1);
  const phase = new Float32Array(1);
  let gainAt1k = 1;
  let node = source;
  for (const [type, frequency, q] of specs) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = qDb(q);
    filter.getFrequencyResponse(at1k, mag, phase);
    gainAt1k *= mag[0];
    node.connect(filter);
    node = filter;
  }
  const normalise = ctx.createGain();
  normalise.gain.value = gainAt1k > 0 && Number.isFinite(gainAt1k) ? 1 / gainAt1k : 1;
  node.connect(normalise);
  return normalise;
}

function describeError(err: unknown): { message: string; denied: boolean } {
  const name = err instanceof DOMException ? err.name : "";
  const text = err instanceof Error ? err.message : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      denied: true,
      message: /system/i.test(text)
        ? "Allow Chrome to use the microphone in macOS System Settings"
        : "Allow microphone access for this page",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return { denied: false, message: "No microphone found" };
  if (name === "NotReadableError" || name === "AbortError") {
    return { denied: false, message: "Microphone is in use or unavailable" };
  }
  return { denied: false, message: "Microphone unavailable" };
}

export default function NoiseMeter() {
  const [status, setStatus] = useState<Status>({ kind: "requesting" });
  const [reading, setReading] = useState<number | null>(null);
  const [peak, setPeak] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let permission: PermissionStatus | null = null;
    let lastStatus = "requesting";
    let denied = false;

    // Fixed-size rolling history: one entry per second, newest last.
    const historyAvg: number[] = [];
    const historyPeak: number[] = [];

    const show = (next: Status) => {
      const key = next.kind === "error" ? `error:${next.message}` : next.kind;
      if (key === lastStatus) return;
      lastStatus = key;
      setStatus(next);
    };

    const noteAudioState = () => {
      if (rootRef.current) rootRef.current.dataset.audio = ctx ? ctx.state : "none";
    };

    const teardown = () => {
      clearInterval(tickTimer);
      clearTimeout(retryTimer);
      tickTimer = undefined;
      retryTimer = undefined;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.onended = null;
          track.stop();
        }
        stream = null;
      }
      if (ctx) {
        ctx.onstatechange = null;
        void ctx.close().catch(() => {});
        ctx = null;
      }
      noteAudioState();
    };

    const fail = (err: unknown) => {
      teardown();
      const info = describeError(err);
      denied = info.denied;
      show({ kind: "error", message: info.message });
      // A denied permission is not retried on a timer (that could re-prompt);
      // it is retried when the permission changes or someone interacts.
      if (!denied) retryTimer = setTimeout(() => void start(), RETRY_MS);
    };

    const start = async () => {
      const gen = ++generation;
      teardown();
      if (disposed) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        show({ kind: "error", message: "Microphone needs https or localhost" });
        return;
      }

      let captured: MediaStream;
      try {
        captured = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        if (!disposed && gen === generation) fail(err);
        return;
      }
      // Unmounted (or restarted) while the prompt was open, e.g. strict mode.
      if (disposed || gen !== generation) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }

      try {
        stream = captured;
        denied = false;
        const audio = new AudioContext({ latencyHint: "playback" });
        ctx = audio;
        const analyser = audio.createAnalyser();
        analyser.fftSize = 2048;
        connectAWeighting(audio, audio.createMediaStreamSource(captured)).connect(analyser);
        // Not connected to the destination: nothing is ever played back.

        for (const track of captured.getAudioTracks()) {
          track.onended = () => {
            if (!disposed && gen === generation) void start();
          };
        }
        audio.onstatechange = noteAudioState;
        void audio.resume().catch(() => {});
        noteAudioState();

        const samples = new Float32Array(analyser.fftSize);
        let fast = -1;
        let slow = -1;
        let last = performance.now();
        let lastUi = 0;
        let secondStart = last;
        let secondSum = 0;
        let secondCount = 0;
        let secondPeak = 0;
        let silentFor = 0;

        tickTimer = setInterval(() => {
          const now = performance.now();
          const dt = Math.max(0.001, (now - last) / 1000);
          last = now;

          if (audio.state !== "running") {
            // Autoplay policy or a system interruption; resume() is a no-op
            // until the browser allows it, and a pointer/key event retries too.
            void audio.resume().catch(() => {});
            show({ kind: "suspended" });
            return;
          }

          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
          const power = sum / samples.length;
          if (!Number.isFinite(power)) return;

          // Exponential averaging of power (not of dB), like a sound level meter.
          if (fast < 0) {
            fast = power;
            slow = power;
          } else {
            fast += (power - fast) * (1 - Math.exp(-dt / FAST_TAU_S));
            slow += (power - slow) * (1 - Math.exp(-dt / SLOW_TAU_S));
          }

          silentFor = power < SILENCE_POWER ? silentFor + dt : 0;
          if (silentFor > SILENCE_AFTER_S) {
            show({ kind: "silent" });
            return;
          }
          show({ kind: "running" });

          const fastDb = toSpl(fast);
          const bar = barRef.current;
          if (bar) {
            bar.style.transform = `scaleY(${scaleFraction(fastDb).toFixed(3)})`;
            bar.dataset.level = levelOf(fastDb);
          }

          secondSum += power;
          secondCount += 1;
          secondPeak = Math.max(secondPeak, fast);
          if (now - secondStart >= 1000) {
            historyAvg.push(toSpl(secondSum / secondCount));
            historyPeak.push(toSpl(secondPeak));
            if (historyAvg.length > HISTORY_SECONDS) {
              historyAvg.shift();
              historyPeak.shift();
            }
            secondStart = now;
            secondSum = 0;
            secondCount = 0;
            secondPeak = 0;
            setHistory(historyAvg.slice());
          }

          if (now - lastUi >= UI_INTERVAL_MS) {
            lastUi = now;
            setReading(Math.round(toSpl(slow)));
            setPeak(Math.round(Math.max(fastDb, toSpl(secondPeak), ...historyPeak)));
            if (rootRef.current) rootRef.current.dataset.dbfs = toDbfs(slow).toFixed(1);
          }
        }, TICK_MS);
      } catch (err) {
        if (!disposed && gen === generation) fail(err);
      }
    };

    const onGesture = () => {
      if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
      else if (!ctx && denied) void start();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && ctx && ctx.state !== "running") {
        void ctx.resume().catch(() => {});
      }
    };
    const onDeviceChange = () => {
      const live = stream?.getAudioTracks().some((track) => track.readyState === "live");
      if (!live && !denied) void start();
    };
    const onPermissionChange = () => {
      if (permission?.state === "granted" && !stream) void start();
      else if (permission?.state === "denied" && stream) void start(); // surfaces the error line
    };

    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    document.addEventListener("visibilitychange", onVisibility);
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((result) => {
        if (disposed) return;
        permission = result;
        result.addEventListener("change", onPermissionChange);
      })
      .catch(() => {});

    void start();

    return () => {
      disposed = true;
      generation += 1;
      teardown();
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      permission?.removeEventListener("change", onPermissionChange);
    };
  }, []);

  const live = status.kind === "running" && reading !== null;
  const level = live ? levelOf(reading) : null;
  const note =
    status.kind === "requesting"
      ? "Waiting for microphone permission"
      : status.kind === "suspended"
        ? "Click or press any key to start the meter"
        : status.kind === "silent"
          ? "The microphone is sending no signal"
          : status.kind === "error"
            ? status.message
            : "Starting";

  return (
    <div ref={rootRef} className={styles.root} data-status={status.kind} role="group" aria-label="Room noise">
      <div className={styles.panel}>
        <div className={styles.label}>Room noise</div>
        {live && level ? (
          <>
            <div className={styles.reading} title="Estimated from the laptop microphone, not a calibrated measurement">
              <span className={styles.approx}>≈</span>
              <span className={styles.value}>{reading}</span>
              <span className={styles.unit}>dB</span>
            </div>
            <div className={styles.detail}>
              <span className={styles.dot} data-level={level} />
              <span>{LEVEL_LABEL[level]}</span>
              {peak !== null && <span className={styles.peak}>peak {peak}</span>}
            </div>
          </>
        ) : (
          <p className={styles.note}>{note}</p>
        )}
        <div className={styles.trend} data-live={live} aria-hidden="true">
          <div className={styles.history}>
            {history.map((db, i) => (
              <span
                // Slots are positional: the newest second is always the last bar.
                key={HISTORY_SECONDS - history.length + i}
                className={styles.bar}
                data-level={levelOf(db)}
                style={{ height: `${Math.max(3, scaleFraction(db) * 100).toFixed(1)}%` }}
              />
            ))}
          </div>
          <div className={styles.levelTrack}>
            <div ref={barRef} className={styles.levelFill} />
          </div>
          <div className={styles.axis}>
            <span>1 min ago</span>
            <span>now</span>
          </div>
        </div>
      </div>
    </div>
  );
}
