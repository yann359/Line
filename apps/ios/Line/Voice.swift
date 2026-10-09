import AVFoundation
import SwiftUI

@MainActor final class Voice: NSObject, ObservableObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    @Published var state = "idle"
    private var recorder: AVAudioRecorder?
    private var file: URL?
    private var timer: Timer?
    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var activeUtterance: AVSpeechUtterance?
    private var speechWait: CheckedContinuation<Void, Error>?
    private var heard = false
    private var lastSound = Date(), start = Date()
    private var completion: ((Result<(Data, String), Error>) -> Void)?
    private var epoch = 0
    override init() { super.init(); synth.delegate = self }
    func speak(_ text: String, api: API, settings: ModelSettings?) async throws {
        let current = epoch
        state = "greeting"
        let session = AVAudioSession.sharedInstance(); try session.setCategory(.playback, mode: .spokenAudio); try session.setActive(true)
        if let provider = settings?.providers["tts"], provider.enabled && provider.adapter != "system" {
            let data = try await api.request("/speak", method: "POST", body: JSONEncoder().encode(["text": text]))
            guard current == epoch else { throw CancellationError() }
            if !data.isEmpty {
                let p = try AVAudioPlayer(data: data); player = p; p.delegate = self
                try await withCheckedThrowingContinuation { continuation in speechWait = continuation; if !p.play() { speechWait = nil; continuation.resume(throwing: LineError.message("无法播放朗读音频")) } }
                player = nil; return
            }
        }
        let utterance = AVSpeechUtterance(string: text); utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        activeUtterance = utterance
        try await withCheckedThrowingContinuation { continuation in speechWait = continuation; synth.speak(utterance) }
    }
    func record(completion: @escaping (Result<(Data, String), Error>) -> Void) async throws {
        let current = epoch
        guard await AVAudioApplication.requestRecordPermission() else { throw LineError.message("请在系统设置允许 Line 使用麦克风") }
        guard current == epoch else { throw CancellationError() }
        let session = AVAudioSession.sharedInstance(); try session.setCategory(.record, mode: .measurement); try session.setActive(true)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("line-\(UUID().uuidString).wav")
        self.file = file
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
        let r = try AVAudioRecorder(url: file, settings: settings); recorder = r; r.isMeteringEnabled = true
        guard r.record() else { cleanup(); throw LineError.message("无法开始录音") }
        self.completion = completion; state = "listening"; heard = false; start = Date(); lastSound = start
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let recorder = self.recorder else { return }
                recorder.updateMeters()
                if recorder.averagePower(forChannel: 0) > -38 { self.heard = true; self.lastSound = Date() }
                if self.heard && Date().timeIntervalSince(self.lastSound) > 2 || Date().timeIntervalSince(self.start) > 60 || !self.heard && Date().timeIntervalSince(self.start) > 10 { self.finish() }
            }
        }
    }
    func finish() {
        guard let recorder, let file else { return }
        recorder.stop(); let endedAt = Dates.iso(Date()), callback = completion
        do { if !heard { throw LineError.message("没有听到声音，请重新录制") }; let data = try Data(contentsOf: file); cleanup(); state = "thinking"; callback?(.success((data, endedAt))) }
        catch { cleanup(); state = "idle"; callback?(.failure(error)) }
    }
    private func cleanup() { timer?.invalidate(); timer = nil; recorder?.stop(); recorder = nil; if let file { try? FileManager.default.removeItem(at: file) }; file = nil; completion = nil; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    func cancel() { epoch += 1; cleanup(); let wait = speechWait; speechWait = nil; activeUtterance = nil; synth.stopSpeaking(at: .immediate); player?.stop(); player = nil; wait?.resume(throwing: CancellationError()); state = "idle" }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { Task { @MainActor in guard self.activeUtterance === utterance else { return }; self.activeUtterance = nil; let wait = self.speechWait; self.speechWait = nil; wait?.resume() } }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { Task { @MainActor in guard self.player === player else { return }; let wait = self.speechWait; self.speechWait = nil; if flag { wait?.resume() } else { wait?.resume(throwing: LineError.message("朗读未播放完成")) } } }
}
