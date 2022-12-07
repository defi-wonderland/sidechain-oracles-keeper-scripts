import {defineConfig} from '@dethcrypto/eth-sdk';

export default defineConfig({
  contracts: {
    mainnet: {
      dataFeedJob: '0x553591d6eac7A127dE36063a1b6cD31D2FB9E42d',
      dataFeed: '0x0209a9bAc6E96C47890573Fc2C20E485f198Da9D',
    },
    goerli: {
      dataFeedJob: '0x606e25c67B8d6550075C8085083c763769Cfe2BE',
      dataFeed: '0x8Fb68E83831c7e8622e10C154CC0d24856440809',
    },
  },
});
