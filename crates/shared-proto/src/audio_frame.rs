use crate::error::ProtoError;

pub const AUDIO_HEADER_LENGTH: u16 = 64;
pub const AUDIO_MAGIC: [u8; 4] = *b"MBF0";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AudioFrameHeader {
    pub magic: [u8; 4],
    pub header_length: u16,
    pub protocol_version: u16,
    pub channel_id: u8,
    pub flags: u8,
    pub samples_per_channel: u16,
    pub profile_id: [u8; 16],
    pub endpoint_id: [u8; 16],
    pub epoch: u64,
    pub sequence: u64,
    pub payload_length: u32,
}

pub mod audio_flags {
    pub const UPLINK_PROFILE_BUS: u8 = 0b0000_0001;
    pub const DOWNLINK_REMOTE_BUS: u8 = 0b0000_0010;
    pub const DISCONTINUITY: u8 = 0b0000_0100;
    pub const SILENCE: u8 = 0b0000_1000;
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SampleFormat {
    PcmF32Le = 1,
}

impl AudioFrameHeader {
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut buf = [0u8; 64];
        buf[0..4].copy_from_slice(&self.magic);
        buf[4..6].copy_from_slice(&self.header_length.to_le_bytes());
        buf[6..8].copy_from_slice(&self.protocol_version.to_le_bytes());
        buf[8] = self.channel_id;
        buf[9] = self.flags;
        buf[10..12].copy_from_slice(&self.samples_per_channel.to_le_bytes());
        buf[12..28].copy_from_slice(&self.profile_id);
        buf[28..44].copy_from_slice(&self.endpoint_id);
        buf[44..52].copy_from_slice(&self.epoch.to_le_bytes());
        buf[52..60].copy_from_slice(&self.sequence.to_le_bytes());
        buf[60..64].copy_from_slice(&self.payload_length.to_le_bytes());
        buf
    }

    pub fn from_bytes(slice: &[u8]) -> Result<Self, ProtoError> {
        if slice.len() < 64 {
            return Err(ProtoError::BufferTooSmall {
                expected: 64,
                actual: slice.len(),
            });
        }
        let magic = [slice[0], slice[1], slice[2], slice[3]];
        if magic != AUDIO_MAGIC {
            return Err(ProtoError::InvalidMagic);
        }
        let header_length = u16::from_le_bytes([slice[4], slice[5]]);
        if header_length != AUDIO_HEADER_LENGTH {
            return Err(ProtoError::InvalidHeaderLength(header_length));
        }
        let protocol_version = u16::from_le_bytes([slice[6], slice[7]]);
        let channel_id = slice[8];
        if !(1..=3).contains(&channel_id) {
            return Err(ProtoError::InvalidChannel(channel_id));
        }
        let flags = slice[9];
        let samples_per_channel = u16::from_le_bytes([slice[10], slice[11]]);
        let mut profile_id = [0u8; 16];
        profile_id.copy_from_slice(&slice[12..28]);
        let mut endpoint_id = [0u8; 16];
        endpoint_id.copy_from_slice(&slice[28..44]);
        let epoch = u64::from_le_bytes([
            slice[44], slice[45], slice[46], slice[47], slice[48], slice[49], slice[50], slice[51],
        ]);
        let sequence = u64::from_le_bytes([
            slice[52], slice[53], slice[54], slice[55], slice[56], slice[57], slice[58], slice[59],
        ]);
        let payload_length = u32::from_le_bytes([slice[60], slice[61], slice[62], slice[63]]);

        Ok(Self {
            magic,
            header_length,
            protocol_version,
            channel_id,
            flags,
            samples_per_channel,
            profile_id,
            endpoint_id,
            epoch,
            sequence,
            payload_length,
        })
    }
}
