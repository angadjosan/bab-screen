// Listens to the room and transcribes it on this Mac with Apple's SpeechAnalyzer (macOS 26), printing one JSON line
// per result: {"text": "...", "final": false} while words are still being decided, then {"final": true} once they
// are settled. lib/stage/ears.ts runs it, looks for the wake phrase and puts what follows on the screen as it is said.
//
//   audio from the default microphone        .data/listen
//   audio from a file, then exit             .data/listen --file speech.aiff
//
// Club words are given to the recogniser as context, so "B@B", "worm" and "EAGLE" come out right. It exits when its
// standard input closes, so it never outlives the server that started it.

import AVFoundation
import Foundation
import Speech

let vocabulary = ["worm", "hey worm", "B@B", "Blockchain at Berkeley", "B@by", "B@bies", "jam", "Spotify Jam", "start a jam", "show the jam", "Hyperliquid", "EAGLE", "MTP", "DeepSeek", "Fireworks", "Ethereum", "Solana", "chumming", "spotbot", "queue"]

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

/// Downloads the on-device English model the first time; a no-op once it is installed.
func ensureModel(for transcriber: SpeechTranscriber) async throws {
  if await AssetInventory.status(forModules: [transcriber]) == .installed { return }
  emit(["status": "downloading speech model"])
  try await AssetInventory.assetInstallationRequest(supporting: [transcriber])?.downloadAndInstall()
}

/// Buffers from the microphone, converted to the format the analyzer wants.
func microphone(into continuation: AsyncStream<AnalyzerInput>.Continuation, format: AVAudioFormat) throws -> AVAudioEngine {
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let natural = input.outputFormat(forBus: 0)
  guard let converter = AVAudioConverter(from: natural, to: format) else { fail("cannot convert microphone audio") }
  input.installTap(onBus: 0, bufferSize: 4096, format: natural) { buffer, _ in
    let ratio = format.sampleRate / natural.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, converted.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: converted)) }
  }
  try engine.start()
  return engine
}

func printResults(of transcriber: SpeechTranscriber) -> Task<Void, Never> {
  Task {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { emit(["text": text, "final": result.isFinal]) }
      }
    } catch {
      emit(["error": "results ended: \(error.localizedDescription)"])
    }
  }
}

func analyzer(for transcriber: SpeechTranscriber) async throws -> SpeechAnalyzer {
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let context = AnalysisContext()
  context.contextualStrings[.general] = vocabulary
  try await analyzer.setContext(context)
  return analyzer
}

func listenToFile(_ path: String, transcriber: SpeechTranscriber) async throws {
  let analyzer = try await analyzer(for: transcriber)
  let printing = printResults(of: transcriber)
  try await analyzer.start(inputAudioFile: AVAudioFile(forReading: URL(fileURLWithPath: path)), finishAfterFile: true)
  await printing.value
}

func listenToMicrophone(transcriber: SpeechTranscriber) async throws {
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { fail("no audio format for the analyzer") }
  let analyzer = try await analyzer(for: transcriber)
  try await analyzer.prepareToAnalyze(in: format)
  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let engine = try microphone(into: continuation, format: format)
  _ = engine
  _ = printResults(of: transcriber)
  emit(["status": "listening"])
  try await analyzer.start(inputSequence: stream)
  // Runs until stdin closes.
  FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { exit(0) }
  }
  while true { try await Task.sleep(for: .seconds(3600)) }
}

let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) ?? Locale(identifier: "en-US")
let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
do {
  try await ensureModel(for: transcriber)
  let arguments = CommandLine.arguments
  if let flag = arguments.firstIndex(of: "--file"), flag + 1 < arguments.count {
    try await listenToFile(arguments[flag + 1], transcriber: transcriber)
  } else {
    try await listenToMicrophone(transcriber: transcriber)
  }
} catch {
  fail(error.localizedDescription)
}
