use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use rtrb::RingBuffer;
use thiserror::Error;

use shared_proto::ChannelId;

use crate::{HubService, PCM_FRAME_SAMPLES};

pub struct MicrophoneCapture {
    stream: Stream,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MicrophoneCapture {
    pub fn start_default(hub: HubService) -> Result<Self, MicrophoneError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(MicrophoneError::NoInputDevice)?;
        let supported = device
            .supported_input_configs()
            .map_err(MicrophoneError::SupportedConfigs)?
            .filter(|config| {
                config.min_sample_rate() <= 48_000 && config.max_sample_rate() >= 48_000
            })
            .find(|config| {
                matches!(
                    config.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
                )
            })
            .ok_or(MicrophoneError::No48kConfig)?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.with_sample_rate(48_000).config();
        let channels = usize::from(config.channels);
        let (mut producer, mut consumer) = RingBuffer::<f32>::new(96_000);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let worker = thread::spawn(move || {
            let mut frame = [0.0_f32; PCM_FRAME_SAMPLES];
            let mut fill = 0;
            while !worker_stopped.load(Ordering::Acquire) {
                match consumer.pop() {
                    Ok(sample) => {
                        frame[fill] = sample;
                        fill += 1;
                        if fill == PCM_FRAME_SAMPLES {
                            for channel in [
                                ChannelId::CHANNEL_1,
                                ChannelId::CHANNEL_2,
                                ChannelId::CHANNEL_3,
                            ] {
                                hub.ingest_microphone_frame(channel, frame);
                            }
                            fill = 0;
                        }
                    }
                    Err(_) => thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        let error_callback = |_error| {};
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                config,
                move |data: &[f32], _| push_downmixed(data, channels, &mut producer),
                error_callback,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                config,
                move |data: &[i16], _| push_downmixed_i16(data, channels, &mut producer),
                error_callback,
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                config,
                move |data: &[u16], _| push_downmixed_u16(data, channels, &mut producer),
                error_callback,
                None,
            ),
            _ => unreachable!("format filtered before stream construction"),
        }
        .map_err(MicrophoneError::BuildStream)?;
        stream.play().map_err(MicrophoneError::PlayStream)?;
        Ok(Self {
            stream,
            stopped,
            worker: Some(worker),
        })
    }

    pub fn stop(&mut self) {
        let _ = self.stream.pause();
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for MicrophoneCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn push_downmixed(data: &[f32], channels: usize, producer: &mut rtrb::Producer<f32>) {
    for input in data.chunks_exact(channels) {
        let sample = input.iter().copied().sum::<f32>() / channels as f32;
        let _ = producer.push(sample);
    }
}

fn push_downmixed_i16(data: &[i16], channels: usize, producer: &mut rtrb::Producer<f32>) {
    for input in data.chunks_exact(channels) {
        let sample = input
            .iter()
            .map(|sample| f32::from(*sample) / 32_768.0)
            .sum::<f32>()
            / channels as f32;
        let _ = producer.push(sample);
    }
}

fn push_downmixed_u16(data: &[u16], channels: usize, producer: &mut rtrb::Producer<f32>) {
    for input in data.chunks_exact(channels) {
        let sample = input
            .iter()
            .map(|sample| (f32::from(*sample) - 32_768.0) / 32_768.0)
            .sum::<f32>()
            / channels as f32;
        let _ = producer.push(sample);
    }
}

#[derive(Debug, Error)]
pub enum MicrophoneError {
    #[error("no physical input device is available")]
    NoInputDevice,
    #[error("the default input does not expose a 48 kHz PCM configuration")]
    No48kConfig,
    #[error("cannot enumerate input configurations: {0}")]
    SupportedConfigs(cpal::Error),
    #[error("cannot build input stream: {0}")]
    BuildStream(cpal::Error),
    #[error("cannot start input stream: {0}")]
    PlayStream(cpal::Error),
}
