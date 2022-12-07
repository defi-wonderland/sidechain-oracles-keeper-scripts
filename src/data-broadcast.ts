import {getMainnetSdk} from '@dethcrypto/eth-sdk-client';
import type {TransactionRequest} from '@ethersproject/abstract-provider';
import type {Contract, Event} from 'ethers';
import {providers, Wallet} from 'ethers';
import {
  createBundlesWithSameTxs,
  getMainnetGasType2Parameters,
  sendAndRetryUntilNotWorkable,
  populateTransactions,
  Flashbots,
} from '@keep3r-network/keeper-scripting-utils';
import dotenv from 'dotenv';
import {getEnvVariable} from './utils/misc';
import {BURST_SIZE, CHAIN_ID, FLASHBOTS_RPC, FUTURE_BLOCKS, PAST_BLOCKS, PRIORITY_FEE, SUPPORTED_CHAIN_IDS} from './utils/contants';

dotenv.config();

/* ==============================================================/*
                          SETUP
/*============================================================== */

// environment variables usage
const provider = new providers.WebSocketProvider(getEnvVariable('RPC_WSS_URI'));
const txSigner = new Wallet(getEnvVariable('TX_SIGNER_PRIVATE_KEY'), provider);
const bundleSigner = new Wallet(getEnvVariable('BUNDLE_SIGNER_PRIVATE_KEY'), provider);

const {dataFeedJob: job, dataFeed} = getMainnetSdk(txSigner);

// Flag to track if there's a transaction in progress. Pool salt + pool nonce => status
const txInProgress: Record<string, boolean> = {};

type PoolObservedEvent = {
  _poolSalt: string;
  _poolNonce: number;
  _observationsData: Array<[number, number]>;
};

/* ==============================================================/*
                       MAIN SCRIPT
/*============================================================== */

export async function initialize(): Promise<void> {
  const flashbots = await Flashbots.init(txSigner, bundleSigner, provider, [FLASHBOTS_RPC], true, CHAIN_ID);
  dataFeed.attach(await job.dataFeed()); // Enforces dataFeed to be the job's one

  const block = await provider.getBlock('latest');
  const queryBlock = block.number - PAST_BLOCKS;
  // eslint-disable-next-line new-cap
  const evtFilter = dataFeed.filters.PoolObserved();
  const queryResults = await dataFeed.queryFilter(evtFilter, queryBlock);
  console.info('Reading PoolObserved events since block', queryBlock);

  await Promise.all(
    queryResults.map(async (event: Event) => {
      const {poolSalt, poolNonce, observationsData} = parseEvent(event);
      await Promise.all(
        SUPPORTED_CHAIN_IDS.map(async (chainId) => {
          return workBroadcastIfNeeded(flashbots, block, poolSalt, poolNonce, chainId, observationsData);
        }),
      );
    }),
  );
}

function parseEvent(event: Event): {poolSalt: string; poolNonce: number; observationsData: Array<[number, number]>} {
  const parsedEvent = dataFeed.interface.decodeEventLog('PoolObserved', event.data, event.topics) as unknown as PoolObservedEvent;
  console.debug(`Parsing event`, {parsedEvent});
  const poolSalt = parsedEvent._poolSalt;
  const poolNonce = parsedEvent._poolNonce;
  const observationsData = parsedEvent._observationsData;
  return {poolSalt, poolNonce, observationsData};
}

export async function run(): Promise<void> {
  const flashbots = await Flashbots.init(txSigner, bundleSigner, provider, [FLASHBOTS_RPC], true, CHAIN_ID);
  dataFeed.attach(await job.dataFeed()); // Enforces dataFeed to be the job's one

  console.info('Waiting for event PoolObserved...');
  // eslint-disable-next-line new-cap
  provider.on(dataFeed.filters.PoolObserved(), async (event: Event) => {
    /**
     * NOTE: codebase for manual fetching of events
     * const POOL_OBSERVED_EVENT_TOPIC = '0xbbea6ef77154be715a6de74ab5aae8710da33d74e2660ead1da5e867ea50d577'
     * const receipt = await provider.getTransactionReceipt('0xea8fd1a7588a0d016da6a08c17daeb26d73673e63e911281b5977935602dae40')
     * const event = receipt.logs.find((log) => log.topics[0] === POOL_OBSERVED_EVENT_TOPIC)
     */

    const block = await provider.getBlock(event.blockNumber);

    console.info(`Event arrived`, {event});
    const {poolSalt, poolNonce, observationsData} = parseEvent(event);

    console.info(`Data fetch`, {poolSalt, poolNonce, observationsData});
    await Promise.all(
      SUPPORTED_CHAIN_IDS.map(async (chainId) => {
        return workBroadcastIfNeeded(flashbots, block, poolSalt, poolNonce, chainId, observationsData);
      }),
    );
  });
}

// eslint-disable-next-line max-params
async function workBroadcastIfNeeded(
  flashbots: Flashbots,
  block: providers.Block,
  poolSalt: string,
  poolNonce: number,
  chainId: number,
  observationsData: Array<[number, number]>,
) {
  const txId = poolSalt + poolNonce.toString();
  const metadata = `pool salt: ${poolSalt}, pool nonce: ${poolNonce}`;

  // Stop if there's already a transaction in progress.
  // We do this to avoid sending multiple transactions that try to work the same job.
  if (txInProgress[txId]) {
    console.debug(`Tx in progress (from ${metadata}). Returning...`);
    return;
  }

  // Check if the job is workable
  const workable = await job['workable(uint32,bytes32,uint24)'](chainId, poolSalt, poolNonce);

  // If it's not workable, then return
  if (!workable) {
    console.info(`Job is not workable for ${metadata}. Returning...`);
    return;
  }

  // If we arrived here, it means we will be sending a transaction, so we optimistically set this to true.
  txInProgress[txId] = true;

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
    functionArgs: [[chainId, poolSalt, poolNonce, observationsData]],
    functionName: 'work(uint32,bytes32,uint24,(uint32,int24)[])',
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
    isWorkableCheck: async () => job['workable(uint32,bytes32,uint24)'](chainId, poolSalt, poolNonce),
  });

  // If the bundle was included, we console log the success
  if (result) console.log('=== Work transaction included successfully ===');

  // We also need to set the job as not in progress anymore.
  txInProgress[txId] = false;
}

(async () => {
  await initialize();
  await run();
})();
