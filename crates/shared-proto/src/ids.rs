use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type ProfileId = Uuid;
pub type EndpointId = Uuid;
pub type SessionId = Uuid;
pub type RequestId = Uuid;
pub type DecimalU64 = String;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Debug)]
#[serde(transparent)]
pub struct ChannelId(pub u8);

impl ChannelId {
    pub const CHANNEL_1: Self = Self(1);
    pub const CHANNEL_2: Self = Self(2);
    pub const CHANNEL_3: Self = Self(3);

    pub fn is_valid(&self) -> bool {
        (1..=3).contains(&self.0)
    }
}
