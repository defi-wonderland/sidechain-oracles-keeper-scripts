import {defineConfig} from '@dethcrypto/eth-sdk';

export default defineConfig({
  contracts: {
    goerli: {
      dataFeedJob: '0x606e25c67B8d6550075C8085083c763769Cfe2BE',
      dataFeed: '0x8Fb68E83831c7e8622e10C154CC0d24856440809',
    },
  },
});
