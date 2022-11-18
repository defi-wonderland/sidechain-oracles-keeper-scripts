import {providers, Wallet} from 'ethers';
import {Flashbots, BlockListener} from '@keep3r-network/keeper-scripting-utils';
import dotenv from 'dotenv';
import {getEnvVariable} from './utils/misc';
import {CHAIN_ID, FLASHBOTS_RPC} from './utils/contants';
import {workFetchIfNeeded, getAllWhitelistedSalts} from './fetch-strategy';

dotenv.config();

/* ==============================================================/*
                          SETUP
/*============================================================== */

// environment variables usage
const provider = new providers.WebSocketProvider(getEnvVariable('RPC_WSS_URI'));
const txSigner = new Wallet(getEnvVariable('TX_SIGNER_PRIVATE_KEY'), provider);
const bundleSigner = new Wallet(getEnvVariable('BUNDLE_SIGNER_PRIVATE_KEY'), provider);

const blockListener = new BlockListener(provider);

// 1: Cooldown time has passed since the last worked timestamp
// 2: Twap difference between pool and oracle has crossed the threshold
const triggerReason = 2;

/* ==============================================================/*
                       MAIN SCRIPT
/*============================================================== */

export async function run(): Promise<void> {
  const flashbots = await Flashbots.init(txSigner, bundleSigner, provider, [FLASHBOTS_RPC], true, CHAIN_ID);

  // Create a subscription and start listening to upcoming blocks
  blockListener.stream(async (block) => {
    // In each block, try to work every supported pool
    const WHITELISTED_POOL_SALTS = await getAllWhitelistedSalts();
    await Promise.all(
      WHITELISTED_POOL_SALTS.map(async (poolSalt) => {
        return workFetchIfNeeded(flashbots, block, poolSalt, triggerReason);
      }),
    );
  });
}

(async () => {
  await run();
})();
