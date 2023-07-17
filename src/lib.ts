import { Config, OdosOnlyDex, OpenOceanOnlyDex, ParaswapOnlyDex } from "./configs";
import Web3 from "web3";
import BN from "bignumber.js";
import {
  TokenData,
  contract,
  convertDecimals,
  eqIgnoreCase,
  erc20,
  isNativeAddress,
  iwethabi,
  parseEvents,
  sendAndWaitForConfirmations,
  setWeb3Instance,
  web3,
  zero,
  zeroAddress,
} from "@defi.org/web3-candies";
import type { TWAP } from "../typechain-hardhat/contracts";
import type { Lens } from "../typechain-hardhat/contracts/periphery/Lens.sol";
import { Paraswap } from "./paraswap";
import _ from "lodash";
import { Odos } from "./odos";
import { OpenOcean } from "./openocean";

export class TWAPLib {
  public static VERSION = 5;
  public twap: TWAP;
  public lens: Lens;

  constructor(public config: Config, public maker: string, public provider?: any) {
    if (provider) setWeb3Instance(new Web3(provider));
    this.twap = contract<TWAP>(config.twapAbi, config.twapAddress);
    this.lens = contract<Lens>(config.lensAbi, config.lensAddress);
  }

  dstAmount = (
    srcToken: TokenData,
    dstToken: TokenData,
    srcAmount: BN.Value,
    srcUsdMarket: BN.Value,
    dstUsdMarket: BN.Value,
    limitDstPriceFor1Src: BN.Value,
    isMarketOrder: boolean
  ) =>
    convertDecimals(
      isMarketOrder ? BN(srcAmount).times(srcUsdMarket).div(dstUsdMarket) : BN(srcAmount).times(limitDstPriceFor1Src),
      srcToken.decimals,
      dstToken.decimals
    ).integerValue(BN.ROUND_FLOOR);

  isNativeToken = (token: TokenData) => isNativeAddress(token.address);

  isWrappedToken = (token: TokenData) => eqIgnoreCase(token.address, this.config.wToken.address);

  isValidChain = (chainId: number) => chainId === this.config.chainId;

  maxPossibleChunks = (srcToken: TokenData, srcAmount: BN.Value, srcUsd: BN.Value) =>
    BN.max(1, BN(srcAmount).div(BN(10).pow(srcToken.decimals).div(srcUsd).times(this.config.minChunkSizeUsd)))
      .integerValue(BN.ROUND_FLOOR)
      .toNumber();

  srcChunkAmount = (srcAmount: BN.Value, totalChunks: BN.Value) =>
    BN(srcAmount).div(totalChunks).integerValue(BN.ROUND_FLOOR);

  totalChunks = (srcAmount: BN.Value, srcChunkAmount: BN.Value) =>
    BN(srcAmount).div(srcChunkAmount).integerValue(BN.ROUND_CEIL).toNumber();

  estimatedDelayBetweenChunksMillis = () => this.config.bidDelaySeconds * 1000 * 2;

  /**
   * includes the bidding war and block settelment
   */
  fillDelayUiMillis = (totalChunks: BN.Value, maxDurationMillis: BN.Value) =>
    BN.max(
      BN(totalChunks).gt(1) ? BN(maxDurationMillis).div(totalChunks) : 0,
      BN(this.estimatedDelayBetweenChunksMillis())
    ).toNumber();

  fillDelayMillis = (totalChunks: BN.Value, maxDurationMillis: BN.Value) =>
    this.fillDelayUiMillis(totalChunks, maxDurationMillis) - this.estimatedDelayBetweenChunksMillis();

  dstMinAmountOut = (
    srcToken: TokenData,
    dstToken: TokenData,
    srcChunkAmount: BN.Value,
    limitDstPriceFor1Src: BN.Value,
    isMarketOrder: boolean
  ) =>
    isMarketOrder
      ? BN(1)
      : BN.max(
          1,
          convertDecimals(
            BN(srcChunkAmount).times(limitDstPriceFor1Src),
            srcToken.decimals,
            dstToken.decimals
          ).integerValue(BN.ROUND_FLOOR)
        );

  dstPriceFor1Src = (
    srcToken: TokenData,
    dstToken: TokenData,
    srcUsdMarket: BN.Value,
    dstUsdMarket: BN.Value,
    srcChunkAmount: BN.Value,
    dstMinAmountOut: BN.Value
  ) =>
    BN(dstMinAmountOut).eq(1)
      ? BN(srcUsdMarket).div(dstUsdMarket)
      : BN(dstMinAmountOut).div(convertDecimals(BN(srcChunkAmount), srcToken.decimals, dstToken.decimals));

  isMarketOrder = (order: Order) => order.ask.dstMinAmount.lte(1);

  orderProgress = (order: Order) => parseFloat(order.filled.srcAmount.div(order.ask.srcAmount).toFixed(4));

  percentAboveMarket = (srcUsdMarket: BN.Value, dstUsdMarket: BN.Value, limitDstPriceFor1Src: BN.Value) =>
    parseFloat(BN(limitDstPriceFor1Src).div(BN(srcUsdMarket).div(dstUsdMarket)).minus(1).toFixed(4));

  status = (order: Order) =>
    order.status > Date.now() / 1000
      ? Status.Open
      : order.status === 1
      ? Status.Canceled
      : order.status === 2
      ? Status.Completed
      : Status.Expired;

  async makerBalance(token: TokenData) {
    if (this.isNativeToken(token)) return web3().eth.getBalance(this.maker).then(BN);
    else return erc20(token.symbol, token.address, token.decimals).methods.balanceOf(this.maker).call().then(BN);
  }

  async wrapNativeToken(amount: BN.Value, maxPriorityFeePerGas?: BN.Value, maxFeePerGas?: BN.Value) {
    await sendAndWaitForConfirmations(
      erc20<any>(
        this.config.wToken.symbol,
        this.config.wToken.address,
        this.config.wToken.decimals,
        iwethabi
      ).methods.deposit(),
      { from: this.maker, maxPriorityFeePerGas, maxFeePerGas, value: amount }
    );
  }

  async unwrapNativeToken(amount: BN.Value, maxPriorityFeePerGas?: BN.Value, maxFeePerGas?: BN.Value) {
    await sendAndWaitForConfirmations(
      erc20<any>(
        this.config.wToken.symbol,
        this.config.wToken.address,
        this.config.wToken.decimals,
        iwethabi
      ).methods.withdraw(BN(amount).toFixed(0)),
      { from: this.maker, maxPriorityFeePerGas, maxFeePerGas }
    );
  }

  async hasAllowance(srcToken: TokenData, amount: BN.Value) {
    if (this.isNativeToken(srcToken)) return true;
    const token = erc20(srcToken.symbol, srcToken.address, srcToken.decimals);
    const allowance = BN(await token.methods.allowance(this.maker, this.config.twapAddress).call());
    return allowance.gte(amount);
  }

  async approve(srcToken: TokenData, amount: BN.Value, maxPriorityFeePerGas?: BN.Value, maxFeePerGas?: BN.Value) {
    const token = erc20(srcToken.symbol, srcToken.address, srcToken.decimals);
    await sendAndWaitForConfirmations(token.methods.approve(this.config.twapAddress, BN(amount).toFixed(0)), {
      from: this.maker,
      maxPriorityFeePerGas,
      maxFeePerGas,
    });
  }

  validateTokens(srcToken: TokenData, dstToken: TokenData) {
    if (_.isEqual(srcToken, dstToken) || (this.isNativeToken(srcToken) && this.isNativeToken(dstToken)))
      return TokensValidation.invalid;

    if (this.isNativeToken(srcToken)) {
      if (this.isWrappedToken(dstToken)) return TokensValidation.wrapOnly;
      return TokensValidation.wrapAndOrder;
    }

    if (this.isWrappedToken(srcToken) && this.isNativeToken(dstToken)) return TokensValidation.unwrapOnly;

    if (this.isNativeToken(dstToken)) return TokensValidation.dstTokenZero;

    return TokensValidation.valid;
  }

  validateOrderInputs(
    srcToken: TokenData,
    dstToken: TokenData,
    srcAmount: BN.Value,
    srcChunkAmount: BN.Value,
    dstMinChunkAmountOut: BN.Value,
    deadline: BN.Value,
    fillDelaySeconds: BN.Value,
    srcUsd: BN.Value
  ): OrderInputValidation {
    const tokensValidation = this.validateTokens(srcToken, dstToken);
    if (tokensValidation === TokensValidation.invalid) return OrderInputValidation.invalidTokens;

    if (BN(srcAmount).lte(0)) return OrderInputValidation.invalidSrcAmount;

    if (BN(srcChunkAmount).lte(0) || BN(srcChunkAmount).gt(srcAmount))
      return OrderInputValidation.invalidSrcChunkAmount;

    if (BN(dstMinChunkAmountOut).lte(0)) return OrderInputValidation.invalidDstMinChunkAmountOut;

    if (BN(deadline).integerValue(BN.ROUND_FLOOR).lte(Date.now())) return OrderInputValidation.invalidDeadline;

    if (BN(fillDelaySeconds).integerValue(BN.ROUND_FLOOR).lt(0)) return OrderInputValidation.invalidFillDelaySeconds;

    if (BN(srcUsd).lte(0)) return OrderInputValidation.invalidSrcUsd;

    if (
      BN(srcChunkAmount)
        .times(srcUsd)
        .lt(BN(this.config.minChunkSizeUsd).times(BN(10).pow(srcToken.decimals)))
    )
      return OrderInputValidation.invalidSmallestSrcChunkUsd;

    return OrderInputValidation.valid;
  }

  async submitOrder(
    srcToken: TokenData,
    dstToken: TokenData,
    srcAmount: BN.Value,
    srcChunkAmount: BN.Value,
    dstMinChunkAmountOut: BN.Value,
    deadline: number,
    fillDelaySeconds: number,
    srcUsd: BN.Value,
    askDataParams: any[] = [],
    maxPriorityFeePerGas?: BN.Value,
    maxFeePerGas?: BN.Value
  ): Promise<number> {
    const validation = this.validateOrderInputs(
      srcToken,
      dstToken,
      srcAmount,
      srcChunkAmount,
      dstMinChunkAmountOut,
      deadline,
      fillDelaySeconds,
      srcUsd
    );
    if (validation !== OrderInputValidation.valid) throw new Error(`invalid inputs: ${validation}`);

    const askData =
      this.config.exchangeType === "PangolinDaasExchange"
        ? web3().eth.abi.encodeParameters(["address"], askDataParams)
        : [];

    const askParams = [
      this.config.exchangeAddress,
      srcToken.address,
      dstToken.address,
      BN(srcAmount).toFixed(0),
      BN(srcChunkAmount).toFixed(0),
      BN(dstMinChunkAmountOut).toFixed(0),
      BN(deadline).div(1000).toFixed(0),
      BN(this.config.bidDelaySeconds).toFixed(0),
      BN(fillDelaySeconds).toFixed(0),
    ];

    let ask: any;
    if (this.config.twapVersion > 3) {
      askParams.push(askData as any);
      ask = this.twap.methods.ask(askParams as any);
    } else {
      ask = (this.twap.methods as any).ask(...askParams);
    }

    const tx = await sendAndWaitForConfirmations(ask, {
      from: this.maker,
      maxPriorityFeePerGas,
      maxFeePerGas,
    });

    const events = parseEvents(tx, this.twap.options.jsonInterface);
    return Number(events[0].returnValues.id);
  }

  async getOrder(id: number): Promise<Order> {
    return this.parseOrder(await this.twap.methods.order(id).call());
  }

  async cancelOrder(id: number, maxPriorityFeePerGas?: BN.Value, maxFeePerGas?: BN.Value) {
    await sendAndWaitForConfirmations(this.twap.methods.cancel(id), {
      from: this.maker,
      maxPriorityFeePerGas,
      maxFeePerGas,
    });
  }

  async getAllOrders() {
    return _.filter(
      _.map(await this.lens.methods.makerOrders(this.maker).call(), (o) => this.parseOrder(o)),
      (o) => eqIgnoreCase(o.ask.exchange, this.config.exchangeAddress)
    );
  }

  async getAllOrdersWithTokens() {
    const orders = await this.getAllOrders();
    const tokens = await Promise.all(
      _.map(
        _.uniq(
          _.concat(
            _.map(orders, (o) => o.ask.srcToken),
            _.map(orders, (o) => o.ask.dstToken)
          )
        ),
        (a) => this.getToken(a)
      )
    );
    return _.map(orders, (o) =>
      _.merge(o, {
        srcToken: _.find(tokens, (t) => eqIgnoreCase(t.address, o.ask.srcToken))!,
        dstToken: _.find(tokens, (t) => eqIgnoreCase(t.address, o.ask.dstToken))!,
      })
    );
  }

  parseOrder(r: any): Order {
    return {
      id: Number(r.id),
      status: Number(r.status),
      time: Number(r.time),
      maker: Web3.utils.toChecksumAddress(r.maker),
      ask: {
        deadline: Number(r.ask.deadline),
        bidDelay: Number(r.ask.bidDelay),
        fillDelay: Number(r.ask.fillDelay),
        exchange: Web3.utils.toChecksumAddress(r.ask.exchange),
        srcToken: Web3.utils.toChecksumAddress(r.ask.srcToken),
        dstToken: Web3.utils.toChecksumAddress(r.ask.dstToken),
        srcAmount: BN(r.ask.srcAmount),
        srcBidAmount: BN(r.ask.srcBidAmount),
        dstMinAmount: BN(r.ask.dstMinAmount),
      },
      bid: {
        time: Number(r.bid?.time || 0),
        taker: Web3.utils.toChecksumAddress(r.bid?.taker || zeroAddress),
        exchange: Web3.utils.toChecksumAddress(r.bid?.exchange || zeroAddress),
        dstAmount: BN(r.bid?.dstAmount || zero),
        dstFee: BN(r.bid?.dstFee || zero),
        data: r.bid?.data || "",
      },
      filled: {
        time: Number(r.filled.time),
        srcAmount: BN(r.filled.srcAmount),
        dstAmount: BN(r.filled.dstAmount),
        dstFee: BN(r.filled.dstFee),
      },
    };
  }

  async getToken(address: string) {
    if (isNativeAddress(address)) return this.config.nativeToken;
    if (eqIgnoreCase(address, this.config.wToken.address)) return this.config.wToken;

    address = Web3.utils.toChecksumAddress(address);
    const t = erc20(address, address);
    const [decimals, symbol] = await Promise.all([t.decimals(), t.methods.symbol().call()]);
    return { address, decimals, symbol };
  }

  async priceUsd(token: TokenData) {
    token = isNativeAddress(token.address) ? this.config.wToken : token;
    const r = await Paraswap.findRoute(
      this.config.chainId,
      token,
      { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", symbol: "NATIVE", decimals: 18 },
      BN(10).pow(token.decimals)
    );
    return r.srcUsd.toNumber();
  }

  async findRoute(srcToken: TokenData, dstToken: TokenData, srcAmount: BN.Value) {
    let route;
    if (this.config.exchangeType === "OdosExchange") {
      route = await Odos.findRoute(
        this.config.chainId,
        srcToken,
        dstToken,
        srcAmount,
        this.config.exchangeAddress,
        this.config.pathfinderKey as OdosOnlyDex,
        this.config.partner
      );
    } else if (this.config.exchangeType === "OpenOceanExchange") {
      route = await OpenOcean.findRoute(
        this.config.chainId,
        srcToken,
        dstToken,
        srcAmount,
        this.config.exchangeAddress,
        this.config.pathfinderKey as OpenOceanOnlyDex,
        this.config.partner
      );
    } else {
      route = await Paraswap.findRoute(
        this.config.chainId,
        srcToken,
        dstToken,
        srcAmount,
        this.config.exchangeAddress,
        this.config.pathfinderKey as ParaswapOnlyDex,
        this.config.partner
      );
    }
    return { ...route, data: this.encodeBidData(route), srcToken, dstToken, srcAmount };
  }

  async findRouteForNextBid(order: Order) {
    if (order.ask.exchange !== zeroAddress && !eqIgnoreCase(order.ask.exchange, this.config.exchangeAddress))
      throw new Error(`mismatched exchange and config`);

    const srcNextChunkAmountIn = BN.min(order.ask.srcBidAmount, order.ask.srcAmount.minus(order.filled.srcAmount));

    const [srcToken, dstToken] = await Promise.all([
      this.getToken(order.ask.srcToken),
      this.getToken(order.ask.dstToken),
    ]);

    return await this.findRoute(srcToken, dstToken, srcNextChunkAmountIn);
  }

  encodeBidData(route: Paraswap.Route | Odos.Route | OpenOcean.Route) {
    switch (this.config.exchangeType) {
      case "UniswapV2Exchange":
      case "PangolinDaasExchange":
        return web3().eth.abi.encodeParameters(["bool", "address[]"], [true, route.path]);
      case "ParaswapExchange":
      case "OdosExchange":
      case "OpenOceanExchange":
        return web3().eth.abi.encodeParameters(["uint256", "bytes"], [route.dstAmount.toFixed(0), route.data]);
      default:
        throw new Error(`unknown exchange type ${this.config.exchangeType}`);
    }
  }
}

export interface Order {
  id: number;
  status: number;
  time: number;
  maker: string;
  ask: {
    deadline: number;
    bidDelay: number;
    fillDelay: number;
    exchange: string;
    srcToken: string;
    dstToken: string;
    srcAmount: BN;
    srcBidAmount: BN;
    dstMinAmount: BN;
  };
  bid: {
    time: number;
    taker: string;
    exchange: string;
    dstAmount: BN;
    dstFee: BN;
    data: string;
  };
  filled: {
    time: number;
    srcAmount: BN;
    dstAmount: BN;
    dstFee: BN;
  };
}

export enum Status {
  Open = "Open",
  Canceled = "Canceled",
  Completed = "Completed",
  Expired = "Expired",
}

export enum OrderInputValidation {
  valid = "valid",
  invalidTokens = "invalidTokens",
  invalidSrcAmount = "invalidSrcAmount",
  invalidSrcChunkAmount = "invalidSrcChunkAmount",
  invalidDstMinChunkAmountOut = "invalidDstMinChunkAmountOut",
  invalidDeadline = "invalidDeadline",
  invalidFillDelaySeconds = "invalidFillDelaySeconds",
  invalidSrcUsd = "invalidSrcUsd",
  invalidSmallestSrcChunkUsd = "invalidSmallestSrcChunkUsd",
}

export enum TokensValidation {
  valid = "valid",
  invalid = "invalid",
  wrapOnly = "wrapOnly",
  unwrapOnly = "unwrapOnly",
  wrapAndOrder = "wrapAndOrder",
  dstTokenZero = "dstTokenZero",
}
