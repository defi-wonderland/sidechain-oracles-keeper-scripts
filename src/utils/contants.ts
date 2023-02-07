// Ethereum
export const CHAIN_ID = 1;

// Size of our batch of bundles
export const BURST_SIZE = 3;

// Blocks into the future to send our first batch of bundles
export const FUTURE_BLOCKS = 1;

// Blocks in the past to read events from
export const PAST_BLOCKS = 500_000;

// Priority fee to use
export const PRIORITY_FEE = 2;

// Flashbots RPC. Taken from https://docs.flashbots.net
export const FLASHBOTS_RPC = 'https://relay.flashbots.net';

export const SUPPORTED_CHAIN_IDS = [10, 137];
