// Reads what this Mac is playing through a Core Audio process tap (macOS 14.2 or later) and prints its loudness
// 30 times a second, one line per frame: "<rms dB> <band 1 dB> ... <band N dB>". lib/audio-levels.ts runs it
// and streams the lines to the page, which draws them along the bottom edge (app/EdgeGlow.tsx).
//
// The tap is a private, unmuted mixdown of everything the Mac plays, so it hears Spotify and the coin flip's
// sounds alike and changes nothing anyone hears. It asks for "System Audio Recording" permission the first time.
// It exits when its standard input closes, so it never outlives the server that started it.

import Accelerate
import AudioToolbox
import CoreAudio
import Foundation

let fftSize = 2048
let bandCount = 32
let lowestHz: Float = 40
let highestHz: Float = 14_000
let framesPerSecond = 30.0
let silentDb: Float = -100

func fail(_ message: String, _ status: OSStatus) -> Never {
  FileHandle.standardError.write("audio-levels: \(message) (OSStatus \(status))\n".data(using: .utf8)!)
  exit(1)
}

func readProperty<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
  if status != noErr { fail("could not read property \(selector)", status) }
  return value
}

/// The last `fftSize` mono samples the tap delivered, written from the audio thread and read by the timer.
final class SampleRing {
  private var samples = [Float](repeating: 0, count: fftSize)
  private var writeAt = 0
  private let lock = NSLock()

  func append(_ pointer: UnsafePointer<Float>, frames: Int, channels: Int) {
    lock.lock()
    defer { lock.unlock() }
    for frame in 0..<frames {
      var sum: Float = 0
      for channel in 0..<channels { sum += pointer[frame * channels + channel] }
      samples[writeAt] = sum / Float(channels)
      writeAt = (writeAt + 1) % fftSize
    }
  }

  func snapshot() -> [Float] {
    lock.lock()
    defer { lock.unlock() }
    return Array(samples[writeAt...] + samples[..<writeAt])
  }
}

/// Loudness per band, from a Hann-windowed FFT of the latest samples. Bands are spaced evenly in pitch, not in Hz.
final class Spectrum {
  private let setup: vDSP_DFT_Setup
  private let window = vDSP.window(ofType: Float.self, usingSequence: .hanningNormalized, count: fftSize, isHalfWindow: false)
  private let edges: [Int]

  init(sampleRate: Float) {
    guard let setup = vDSP_DFT_zop_CreateSetup(nil, vDSP_Length(fftSize), .FORWARD) else { fail("could not set up the FFT", 0) }
    self.setup = setup
    let binHz = sampleRate / Float(fftSize)
    // At the bottom of the range several bands would share one FFT bin; each band gets at least a bin of its own.
    var edges: [Int] = []
    for band in 0...bandCount {
      let hz = lowestHz * pow(highestHz / lowestHz, Float(band) / Float(bandCount))
      let bin = min(fftSize / 2 - 1, Int((hz / binHz).rounded()))
      edges.append(max(bin, (edges.last ?? 0) + 1))
    }
    self.edges = edges
  }

  func levels(of samples: [Float]) -> (rms: Float, bands: [Float]) {
    let windowed = vDSP.multiply(samples, window)
    var real = [Float](repeating: 0, count: fftSize)
    var imaginary = [Float](repeating: 0, count: fftSize)
    let zeros = [Float](repeating: 0, count: fftSize)
    vDSP_DFT_Execute(setup, windowed, zeros, &real, &imaginary)
    var power = [Float](repeating: 0, count: fftSize / 2)
    for bin in 0..<(fftSize / 2) { power[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin] }
    let bands = (0..<bandCount).map { band -> Float in
      let from = min(edges[band], fftSize / 2 - 1)
      let to = min(max(from + 1, edges[band + 1]), fftSize / 2)
      let mean = power[from..<to].reduce(0, +) / Float(to - from)
      return mean > 0 ? max(silentDb, 10 * log10(mean)) : silentDb
    }
    let rms = vDSP.rootMeanSquare(samples)
    return (rms > 0 ? max(silentDb, 20 * log10(rms)) : silentDb, bands)
  }
}

let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.muteBehavior = .unmuted
tapDescription.isPrivate = true

var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tapDescription, &tapID)
if status != noErr { fail("could not create the process tap; is System Audio Recording allowed?", status) }

let outputDevice: AudioDeviceID = readProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(kAudioObjectUnknown))
func deviceUID(_ device: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var uid: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid)
  guard status == noErr, let uid else { fail("could not read the output device's UID", status) }
  return uid.takeRetainedValue() as String
}

let outputUID = deviceUID(outputDevice)
let tapFormat: AudioStreamBasicDescription = readProperty(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())

let aggregate: [String: Any] = [
  kAudioAggregateDeviceNameKey: "bab-screen audio levels",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
if status != noErr { fail("could not create the aggregate device", status) }

let ring = SampleRing()
let channels = max(1, Int(tapFormat.mChannelsPerFrame))
let audioQueue = DispatchQueue(label: "audio-levels.io", qos: .userInteractive)
var ioProc: AudioDeviceIOProcID?
status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateID, audioQueue) { _, input, _, _, _ in
  for buffer in UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)) {
    guard let data = buffer.mData else { continue }
    let stride = max(1, Int(buffer.mNumberChannels))
    let frames = Int(buffer.mDataByteSize) / (MemoryLayout<Float>.size * stride)
    ring.append(data.assumingMemoryBound(to: Float.self), frames: frames, channels: min(stride, channels))
    break
  }
}
if status != noErr { fail("could not add the IO proc", status) }

func shutDown() -> Never {
  if let ioProc {
    AudioDeviceStop(aggregateID, ioProc)
    AudioDeviceDestroyIOProcID(aggregateID, ioProc)
  }
  AudioHardwareDestroyAggregateDevice(aggregateID)
  AudioHardwareDestroyProcessTap(tapID)
  exit(0)
}

status = AudioDeviceStart(aggregateID, ioProc)
if status != noErr { fail("could not start the aggregate device", status) }

let spectrum = Spectrum(sampleRate: Float(tapFormat.mSampleRate))
setvbuf(stdout, nil, _IOLBF, 0)
let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "audio-levels.timer"))
timer.schedule(deadline: .now(), repeating: 1 / framesPerSecond)
timer.setEventHandler {
  let (rms, bands) = spectrum.levels(of: ring.snapshot())
  print(([rms] + bands).map { String(format: "%.1f", $0) }.joined(separator: " "))
}
timer.resume()

for signalNumber in [SIGINT, SIGTERM] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler { shutDown() }
  source.resume()
  _ = Unmanaged.passRetained(source)
}

FileHandle.standardInput.readabilityHandler = { handle in
  if handle.availableData.isEmpty { DispatchQueue.main.async { shutDown() } }
}

dispatchMain()
