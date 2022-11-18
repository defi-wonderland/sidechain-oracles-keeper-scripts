import {getGoerliSdk} from '@dethcrypto/eth-sdk-client';
import type {TransactionRequest} from '@ethersproject/abstract-provider';
import type {Contract} from 'ethers';
import {providers, Wallet} from 'ethers';
import type {Flashbots} from '@keep3r-network/keeper-scripting-utils';
import {
  createBundlesWithSameTxs,
  getMainnetGasType2Parameters,
  sendAndRetryUntilNotWorkable,
  populateTransactions,
} from '@keep3r-network/keeper-scripting-utils';
import dotenv from 'dotenv';
import {getEnvVariable} from './utils/misc';
import {BURST_SIZE, CHAIN_ID, FUTURE_BLOCKS, PRIORITY_FEE} from './utils/contants';

dotenv.config();

/* ==============================================================/*
                          SETUP
/*============================================================== */

// environment variables usage
const provider = new providers.WebSocketProvider(getEnvVariable('RPC_WSS_URI'));
const txSigner = new Wallet(getEnvVariable('TX_SIGNER_PRIVATE_KEY'), provider);

const {dataFeedJob: job, dataFeed} = getGoerliSdk(txSigner);

// Flag to track if there's a transaction in progress. Pool salt => status
const txInProgress: Record<string, boolean> = {};

/* ==============================================================/*
                      AVAILABLE POOLS
/*============================================================== */

export async function getAllWhitelistedSalts(): Promise<string[]> {
  dataFeed.attach(await job.dataFeed()); // Enforces dataFeed to be the job's one
  const whitelistedSalts = await dataFeed.whitelistedPools();
  return whitelistedSalts;
}

/* ==============================================================/*
                       FETCH LOGIC
/*============================================================== */

export async function workFetchIfNeeded(flashbots: Flashbots, block: providers.Block, poolSalt: string, triggerReason: number) {
  // Stop if there's already a transaction in progress.
  // We do this to avoid sending multiple transactions that try to work the same job.
  if (txInProgress[poolSalt]) {
    console.debug(`Tx in progress (from block ${block.number}). Returning...`);
    return;
  }

  // Check if the job is workable
  const workable = await job['workable(bytes32,uint8)'](poolSalt, triggerReason);

  // If it's not workable, then return
  if (!workable) {
    console.info(`Job is not workable for pool salt ${poolSalt}. Returning...`);
    return;
  }

  // If we arrived here, it means we will be sending a transaction, so we optimistically set this to true.
  txInProgress[poolSalt] = true;

  /*
    We are going to send this through Flashbots, which means we will be sending multiple bundles to different
    blocks inside a batch. Here we are calculating which will be the last block we will be sending the
    last bundle of our first batch to. This information is needed to calculate what will the maximum possible base
    fee be in that block, so we can calculate the maxFeePerGas parameter for all our transactions.
    For example: we are in block 100 and we send to 100, 101, 102. We would like to know what is the maximum possible
    base fee at block 102 to make sure we don't populate our transactions with a very low maxFeePerGas, as this would
    cause our transaction to not be mined until the max base fee lowers.
  */
  const blocksAhead = FUTURE_BLOCKS + BURST_SIZE;

  // Get the signer's (keeper) current nonce.
  const currentNonce = await provider.getTransactionCount(txSigner.address);

  // Fetch the priorityFeeInGwei and maxFeePerGas parameters from the getMainnetGasType2Parameters function
  // NOTE: this just returns our priorityFee in GWEI, it doesn't calculate it, so if we pass a priority fee of 10 wei
  //       this will return a priority fee of 10 GWEI. We need to pass it so that it properly calculated the maxFeePerGas
  const {priorityFeeInGwei, maxFeePerGas} = getMainnetGasType2Parameters({
    block,
    blocksAhead,
    priorityFeeInWei: PRIORITY_FEE,
  });

  // We declare what options we would like our transaction to have
  const options = {
    gasLimit: 10_000_000,
    nonce: currentNonce,
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFeeInGwei,
    type: 2,
  };

  // We populate the transactions we will use in our bundles
  const txs: TransactionRequest[] = await populateTransactions({
    chainId: CHAIN_ID,
    contract: job as Contract,
    functionArgs: [[poolSalt, triggerReason]],
    functionName: 'work(bytes32,uint8)',
    options,
  });

  // We calculate the first block that the first bundle in our batch will target.
  // Example, if future blocks is 2, and we are in block 100, it will send a bundle to blocks 102, 103, 104 (assuming a burst size of 3)
  // and 102 would be the firstBlockOfBatch
  const firstBlockOfBatch = block.number + FUTURE_BLOCKS;

  // We create our batch of bundles. In this case we use createBundlesWithSameTxs, as all bundles use the same transaction
  const bundles = createBundlesWithSameTxs({
    unsignedTxs: txs,
    burstSize: BURST_SIZE,
    firstBlockOfBatch,
  });

  // We send our bundles to Flashbots and retry until the job is worked by us or another keeper.
  const result = await sendAndRetryUntilNotWorkable({
    txs,
    provider,
    priorityFeeInWei: PRIORITY_FEE,
    bundles,
    newBurstSize: BURST_SIZE,
    flashbots,
    signer: txSigner,
    isWorkableCheck: async () => job['workable(bytes32,uint8)'](poolSalt, triggerReason),
  });

  // If the bundle was included, we console log the success
  if (result) console.log('=== Work transaction included successfully ===');

  // We also need to set the job as not in progress anymore.
  txInProgress[poolSalt] = false;
}
