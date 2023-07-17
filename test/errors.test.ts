import {
  deployer,
  dstToken,
  exchange,
  initFixture,
  network,
  setMockExchangeAmountOut,
  srcToken,
  swapBidDataForUniV2,
  taker,
  twap,
  user,
  withMockExchange,
  withUniswapV2Exchange,
  ask,
  bid,
  endTime,
  fill,
  order,
  time,
} from "./fixture";
import { account, zeroAddress } from "@defi.org/web3-candies";
import { deployArtifact, expectRevert, mineBlock } from "@defi.org/web3-candies/dist/hardhat";
import { expect } from "chai";
import { MockExchange } from "../typechain-hardhat/contracts/test";

describe("Errors", () => {
  beforeEach(() => initFixture());
  beforeEach(() => withUniswapV2Exchange());

  describe("order", () => {
    it("invalid id", async () => {
      await expectRevert(() => twap.methods.order(0).call(), "invalid id");
      await expectRevert(() => twap.methods.order(123).call(), "invalid id");
    });

    describe("invalid params", () => {
      let now = 0;
      beforeEach(async () => (now = await time()));

      [
        {
          name: "srcToken zero",
          act: async () =>
            twap.methods.ask([zeroAddress, zeroAddress, dstToken.address, 10, 5, 10, now + 10, 60, 60, []]),
        },
        {
          name: "same tokens",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, srcToken.address, 10, 5, 10, now + 10, 60, 60, []]),
        },
        {
          name: "srcAmount zero",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 0, 5, 10, now + 10, 60, 60, []]),
        },
        {
          name: "srcBidAmount zero",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 10, 0, 10, now + 10, 60, 60, []]),
        },
        {
          name: "srcBidAmount>srcAmount",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 10, 11, 10, now + 10, 60, 60, []]),
        },
        {
          name: "dstMinAmount zero",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 10, 5, 0, now + 10, 60, 60, []]),
        },
        {
          name: "expired",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 10, 5, 10, now, 60, 60, []]),
        },
        {
          name: "bid delay lower than minimum",
          act: async () =>
            twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 10, 5, 10, now + 10, 5, 60, []]),
        },
        {
          name: "weth to native",
          act: async () =>
            twap.methods.ask([zeroAddress, network.wToken.address, zeroAddress, 10, 5, 10, now + 10, 60, 60, []]),
        },
        {
          name: "same tokens native",
          act: async () =>
            twap.methods.ask([
              zeroAddress,
              network.wToken.address,
              network.wToken.address,
              10,
              5,
              10,
              now + 10,
              40,
              60,
              [],
            ]),
        },
      ].map((i) =>
        it(i.name, async () => {
          expect(await twap.methods.MIN_BID_DELAY_SECONDS().call().then(parseInt)).eq(30);
          twap.methods.ask([zeroAddress, srcToken.address, dstToken.address, 10, 5, 10, now + 10, 60, 60, []]); //valid
          await expectRevert(async () => (await i.act()).call(), "params");
        })
      );
    });

    it("insufficient maker allowance", async () => {
      await srcToken.methods.approve(twap.options.address, 5).send({ from: user });
      await expectRevert(
        () =>
          twap.methods
            .ask([zeroAddress, srcToken.address, dstToken.address, 100, 10, 1, endTime(), 60, 60, []])
            .send({ from: user }),
        "maker allowance"
      );
    });

    it("insufficient maker balance", async () => {
      await srcToken.methods.approve(twap.options.address, 15).send({ from: user });
      await srcToken.methods.transfer(taker, await srcToken.methods.balanceOf(user).call()).send({ from: user });
      await expectRevert(
        () =>
          twap.methods
            .ask([zeroAddress, srcToken.address, dstToken.address, 100, 10, 1, endTime(), 60, 60, []])
            .send({ from: user }),
        "maker balance"
      );
    });
  });

  describe("verify bid", () => {
    it("expired", async () => {
      await ask(2000, 2000, 1, (await time()) + 10);
      await mineBlock(60);
      await expectRevert(() => bid(0), "status");

      await ask(2000, 2000, 1, (await time()) + 10);
      await bid(1);
    });

    it("invalid exchange", async () => {
      await withMockExchange(1);
      const otherExchange = await deployArtifact<MockExchange>("MockExchange", { from: deployer });

      await ask(2000, 2000, 1, undefined, exchange.options.address);
      await mineBlock(60);
      await expectRevert(
        () => twap.methods.bid(0, otherExchange.options.address, 0, 0, swapBidDataForUniV2).call(),
        "exchange"
      );
      await twap.methods.bid(0, exchange.options.address, 0, 0, swapBidDataForUniV2).call();
    });

    it("low bid", async () => {
      await ask(2000, 2000, 1);
      await bid(0);
      await expectRevert(() => bid(0), "low bid");

      await ask(2000, 2000, 1);
      await bid(1);
    });

    it("recently filled", async () => {
      await ask(2000, 1000, 0.5, undefined, undefined, undefined, 100);
      await bid(0);
      await mineBlock(60);
      await fill(0);

      await expectRevert(() => bid(0), "fill delay");

      await mineBlock(parseInt((await order(0)).ask.fillDelay));
      await bid(0);
    });

    it("recently filled custom fill delay", async () => {
      await ask(2000, 1000, 0.5, undefined, undefined, 60, 600);
      await bid(0);
      await mineBlock(60);
      await fill(0);

      await expectRevert(() => bid(0), "fill delay");

      await mineBlock(60);
      await expectRevert(() => bid(0), "fill delay");

      await mineBlock(600);
      await bid(0);
    });

    it("insufficient amount out", async () => {
      await ask(2000, 1000, 2);
      await expectRevert(() => bid(0), "min out");
    });

    it("insufficient amount out with excess fee", async () => {
      await ask(2000, 1000, 0.5);
      await expectRevert(() => bid(0, 0.1), "min out");
    });

    it("fee underflow protection", async () => {
      await ask(2000, 1000, 0.5);
      await expectRevert(() => bid(0, 1), /(Arithmetic operation underflowed|reverted)/);
    });

    it("insufficient amount out when last partial fill", async () => {
      await ask(2000, 1500, 0.75);
      await bid(0);
      await mineBlock(60);
      await fill(0);

      await withMockExchange(0.1);
      await expectRevert(() => bid(0), "min out");
    });

    it("insufficient user allowance", async () => {
      await ask(2000, 2000, 1);
      await srcToken.methods.approve(twap.options.address, 0).send({ from: user });
      await expectRevert(() => bid(0), "maker allowance");
    });

    it("insufficient user balance", async () => {
      await ask(2000, 2000, 1);
      await srcToken.methods.transfer(taker, await srcToken.methods.balanceOf(user).call()).send({ from: user });
      await expectRevert(() => bid(0), "maker balance");
    });
  });

  describe("perform fill", () => {
    it("expired", async () => {
      await ask(2000, 1000, 0.5);
      await bid(0);
      await mineBlock(10000);
      await expectRevert(() => fill(0), "status");
    });

    it("invalid taker when no existing bid", async () => {
      await ask(2000, 1000, 0.5);
      await expectRevert(() => fill(0), "taker");
    });

    it("invalid taker when not the winning taker", async () => {
      await ask(2000, 1000, 0.5);
      await bid(0);
      const otherTaker = await account(9);
      expect(otherTaker).not.eq(taker);
      await expectRevert(() => twap.methods.fill(0).send({ from: otherTaker }), "taker");
    });

    it("pending bid when still in bidding window of bid delay", async () => {
      await ask(2000, 1000, 0.5);
      await bid(0);
      await expectRevert(() => fill(0), "bid delay");
    });

    it("pending bid with custom delay", async () => {
      await ask(2000, 1000, 0.5, endTime(), undefined, 1234, 9999);
      await bid(0);

      await mineBlock(1000);
      await expectRevert(() => fill(0), "bid delay");

      await mineBlock(234);
      await fill(0);
    });

    it("insufficient out", async () => {
      await ask(2000, 1000, 0.5);

      await withMockExchange(1);

      await bid(0);
      await mineBlock(60);

      await setMockExchangeAmountOut(0.1);
      await expectRevert(() => fill(0), "min out");
    });

    it("insufficient out with excess fee", async () => {
      await ask(2000, 1000, 0.5);

      await withMockExchange(1);

      await bid(0, 0.1);
      await mineBlock(60);

      await setMockExchangeAmountOut(0.5);
      await expectRevert(() => fill(0), "min out");
    });

    it("fee subtracted from dstAmountOut underflow protection", async () => {
      await ask(2000, 1000, 0.5);

      await withMockExchange(10);

      await bid(0, 1);
      await mineBlock(60);

      await setMockExchangeAmountOut(0.5);
      await expectRevert(() => fill(0), /(Arithmetic operation underflowed|reverted)/);
    });
  });

  it("cancel only from maker", async () => {
    await ask(1, 1, 1);
    await expectRevert(() => twap.methods.cancel(0).send({ from: deployer }), "maker");
  });

  it("prune only invalid orders", async () => {
    await ask(1000, 100, 0.01, undefined, undefined, undefined, 60);
    await expectRevert(() => twap.methods.prune(0).send({ from: deployer }), "valid");

    await bid(0, 0);
    await mineBlock(60);
    await fill(0);
    await expectRevert(() => twap.methods.prune(0).send({ from: deployer }), "fill delay");

    await twap.methods.cancel(0).send({ from: user });
    await expectRevert(() => twap.methods.prune(0).send({ from: deployer }), "status");
  });

  it("bid params", async () => {
    await expectRevert(() => twap.methods.bid(0, zeroAddress, 0, 0, []).send({ from: taker }), "params");
    await expectRevert(
      () => twap.methods.bid(0, exchange.options.address, 0, 110_000, []).send({ from: taker }),
      "params"
    );
  });
});
