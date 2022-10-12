# Sidechain Oracle Keeper Script

This repository enables keepers of the Keep3r Network to execute Sidechain Oracle's jobs on Goerli.

## How to run

1. Clone the repository

```
  git clone https://github.com/defi-wonderland/sidechain-oracle-keeper-scripts
```

2. Install dependencies

```
  yarn install
```

3. Create and complete the `.env` file using `env.example` as an example

4. Fine-tune the constants in `src/constants.ts` to your liking. Read [the docs](https://docs.keep3r.network/keeper-scripts) for a technical in-depth explanation.

5. Try out the scripts

```
  yarn start:data-feed
```

## Run in production

1. Build the typescript into javascript

```
  yarn build
```

2. Run the job directly from javascript (using [PM2](https://github.com/Unitech/pm2) is highly recommended)

```
  node dist/data-feed-job.js
```

## Keeper Requirements

- Must be a valid (activated) Keeper on [Goerli Keep3r V2](https://goerli.etherscan.io/address/0x145d364e193204f8Ff0A87b718938406595678Dd)

## Useful Links

- [Data Feed Job](https://goerli.etherscan.io/address/0xA4dcC6D2E6B60aD99BbaFbA59Aee59280EA96368)
