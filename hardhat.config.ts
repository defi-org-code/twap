import { chainId, contract, estimateGasPrice, sendAndWaitForConfirmations } from "@defi.org/web3-candies";
import {
  artifact,
  askDeployer,
  askFees,
  deploy,
  hardhatDefaultConfig,
  isHardhatNetwork,
} from "@defi.org/web3-candies/dist/hardhat";
import "@nomiclabs/hardhat-etherscan";
import "@nomiclabs/hardhat-web3";
import "@typechain/hardhat";
import "dotenv/config";
import fs from "fs-extra";
import "hardhat-gas-reporter";
import "hardhat-tracer";
import { HardhatUserConfig, task } from "hardhat/config";
import _ from "lodash";

task("deploy").setAction(async () => {
  if (isHardhatNetwork()) throw new Error("on hardhat network!");
  const config = require("./src/configs").chainConfig(await chainId());

  const takers = [];

  const address = await deploy({
    contractName: "Taker",
    args: [config.twapAddress, takers],
    waitForConfirmations: 1,
  });
});

task("github-pages").setAction(async () => {
  const src = require("./src");
  await fs.mkdirp("./docs");
  await fs.writeJson("./docs/configs.json", src.Configs, { spaces: 2 });
  await fs.writeJson(
    "./docs/chain-configs.json",
    _.mapValues(src.ChainConfigs, (cc) => ({
      ...cc,
      integrations: _.filter(src.Configs, (c) => c.chainId === cc.chainId).map((c) => c.name),
    })),
    { spaces: 2 }
  );
});

export default _.merge(hardhatDefaultConfig(), {
  solidity: {
    compilers: [
      {
        version: "0.8.16",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      blockGasLimit: 15e6,
    },
  },
} as HardhatUserConfig);
