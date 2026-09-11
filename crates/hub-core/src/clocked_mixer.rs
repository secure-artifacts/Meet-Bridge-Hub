use crate::mixer::{MixEndpoint, NMinusOneMatrix, PCM_FRAME_SAMPLES};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};
pub const PREBUFFER_FRAMES: usize = 6;
pub const MAX_QUEUED_FRAMES: usize = 50;
pub const MAX_INPUT_AGE: Duration = Duration::from_millis(250);
type Frame = [f32; PCM_FRAME_SAMPLES];
struct QueuedFrame {
    samples: Frame,
    enqueued_at: Instant,
}
#[derive(Default)]
struct InputQueue {
    frames: VecDeque<QueuedFrame>,
    started: bool,
    last_sample: f32,
}
#[derive(Default)]
pub struct ClockedMixer {
    matrix: NMinusOneMatrix,
    inputs: HashMap<MixEndpoint, InputQueue>,
    pub underruns: u64,
    pub dropped_frames: u64,
}
impl ClockedMixer {
    pub fn register(&mut self, endpoint: MixEndpoint) {
        if self.matrix.register(endpoint) {
            self.inputs.entry(endpoint).or_default();
        }
    }
    pub fn remove(&mut self, endpoint: MixEndpoint) {
        self.inputs.remove(&endpoint);
        self.matrix.remove(endpoint);
    }
    pub fn enqueue(&mut self, endpoint: MixEndpoint, samples: Frame) -> bool {
        self.enqueue_at(endpoint, samples, Instant::now())
    }
    fn enqueue_at(&mut self, endpoint: MixEndpoint, samples: Frame, enqueued_at: Instant) -> bool {
        let Some(input) = self.inputs.get_mut(&endpoint) else {
            return false;
        };
        if input.frames.len() == MAX_QUEUED_FRAMES {
            input.frames.pop_front();
            self.dropped_frames += 1;
        }
        input.frames.push_back(QueuedFrame {
            samples,
            enqueued_at,
        });
        true
    }
    // Exactly once per shared tick, before mixing any destinations.
    pub fn advance(&mut self) {
        let now = Instant::now();
        for (endpoint, input) in &mut self.inputs {
            while input.frames.front().is_some_and(|frame| {
                now.saturating_duration_since(frame.enqueued_at) > MAX_INPUT_AGE
            }) {
                input.frames.pop_front();
                self.dropped_frames += 1;
            }
            if !input.started && input.frames.len() >= PREBUFFER_FRAMES {
                input.started = true;
            }
            let frame = if input.started {
                if let Some(frame) = input.frames.pop_front() {
                    input.last_sample = frame.samples[PCM_FRAME_SAMPLES - 1];
                    frame.samples
                } else {
                    self.underruns += 1;
                    input.started = false;
                    let mut silence = [0.0; PCM_FRAME_SAMPLES];
                    for (index, sample) in silence.iter_mut().take(240).enumerate() {
                        *sample = input.last_sample * (1.0 - index as f32 / 239.0);
                    }
                    input.last_sample = 0.0;
                    silence
                }
            } else {
                [0.0; PCM_FRAME_SAMPLES]
            };
            self.matrix.set_input(*endpoint, frame);
        }
    }
    pub fn mix_for(&self, endpoint: MixEndpoint) -> Frame {
        self.matrix.mix_for(endpoint)
    }
    pub fn mix_for_excluding(&self, endpoint: MixEndpoint, excluded: &[MixEndpoint]) -> Frame {
        self.matrix.mix_for_excluding(endpoint, excluded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared_proto::ChannelId;
    use uuid::Uuid;
    fn endpoint(channel: ChannelId) -> MixEndpoint {
        MixEndpoint {
            endpoint_id: Uuid::new_v4(),
            channel_id: channel,
        }
    }

    #[test]
    fn burst_frames_preserve_order_for_multiple_receivers_and_never_return_self() {
        let mut mixer = ClockedMixer::default();
        let source = endpoint(ChannelId::CHANNEL_1);
        let a = endpoint(ChannelId::CHANNEL_1);
        let b = endpoint(ChannelId::CHANNEL_1);
        let other = endpoint(ChannelId::CHANNEL_2);
        let third = endpoint(ChannelId::CHANNEL_3);
        for e in [source, a, b, other, third] {
            mixer.register(e);
        }
        for i in 1..=12 {
            assert!(mixer.enqueue(source, [i as f32 / 100.0; PCM_FRAME_SAMPLES]));
        }
        for i in 1..=12 {
            mixer.advance();
            assert_eq!(mixer.mix_for(a), [i as f32 / 100.0; PCM_FRAME_SAMPLES]);
            assert_eq!(mixer.mix_for(b), mixer.mix_for(a));
            for e in [source, other, third] {
                assert_eq!(mixer.mix_for(e), [0.0; PCM_FRAME_SAMPLES]);
            }
        }
        mixer.advance(); // fade, not repetition
        assert_eq!(mixer.mix_for(a)[479], 0.0);
        mixer.advance();
        assert_eq!(mixer.mix_for(a), [0.0; PCM_FRAME_SAMPLES]);
        assert_eq!(mixer.underruns, 1);
        assert_eq!(mixer.dropped_frames, 0);
    }

    #[test]
    fn sixty_seconds_of_batched_sine_frames_are_sample_exact() {
        let mut mixer = ClockedMixer::default();
        let source = endpoint(ChannelId::CHANNEL_1);
        let target = endpoint(ChannelId::CHANNEL_1);
        mixer.register(source);
        mixer.register(target);
        let make_frame = |frame: usize| -> Frame {
            std::array::from_fn(|sample| {
                let phase =
                    (frame * PCM_FRAME_SAMPLES + sample) as f64 * std::f64::consts::TAU * 437.0
                        / 48_000.0;
                (phase.sin() * 0.25) as f32
            })
        };
        let mut sent = 0;
        for tick in 0..6000 {
            // Six frames initially, then batches of three every three ticks.
            let count = if tick == 0 {
                6
            } else if tick % 3 == 0 {
                3
            } else {
                0
            };
            for _ in 0..count {
                mixer.enqueue(source, make_frame(sent));
                sent += 1;
            }
            mixer.advance();
            assert_eq!(
                mixer.mix_for(target),
                make_frame(tick),
                "sample continuity at tick {tick}"
            );
        }
        assert_eq!(mixer.underruns, 0);
        assert_eq!(mixer.dropped_frames, 0);
    }

    #[test]
    fn overflow_is_bounded_and_removal_discards_pending_audio() {
        let mut mixer = ClockedMixer::default();
        let source = endpoint(ChannelId::CHANNEL_1);
        let target = endpoint(ChannelId::CHANNEL_1);
        mixer.register(source);
        mixer.register(target);
        for i in 0..100 {
            mixer.enqueue(source, [i as f32 / 100.0; PCM_FRAME_SAMPLES]);
        }
        assert_eq!(mixer.dropped_frames, 50);
        assert_eq!(mixer.inputs[&source].frames.len(), MAX_QUEUED_FRAMES);
        mixer.advance();
        assert_eq!(mixer.mix_for(target)[0], 0.5);
        mixer.remove(source);
        mixer.register(source);
        mixer.advance();
        assert_eq!(mixer.mix_for(target), [0.0; PCM_FRAME_SAMPLES]);
    }

    #[test]
    fn stale_input_is_discarded_before_fresh_prebuffer_is_rendered() {
        let mut mixer = ClockedMixer::default();
        let source = endpoint(ChannelId::CHANNEL_1);
        let target = endpoint(ChannelId::CHANNEL_1);
        mixer.register(source);
        mixer.register(target);
        let stale_at = Instant::now() - MAX_INPUT_AGE - Duration::from_millis(1);
        mixer.enqueue_at(source, [0.9; PCM_FRAME_SAMPLES], stale_at);
        for _ in 0..PREBUFFER_FRAMES {
            mixer.enqueue(source, [0.25; PCM_FRAME_SAMPLES]);
        }
        mixer.advance();
        assert_eq!(mixer.mix_for(target), [0.25; PCM_FRAME_SAMPLES]);
        assert_eq!(mixer.dropped_frames, 1);
    }
}
