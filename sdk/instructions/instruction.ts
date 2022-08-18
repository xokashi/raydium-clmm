import { BN } from "@project-serum/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";

import { programs } from "@metaplex/js";
import { getTickArrayStartIndexByTick } from "../entities";
import {
  SqrtPriceMath,
  LiquidityMath,
  ONE,
  MIN_SQRT_PRICE_X64,
  MAX_SQRT_PRICE_X64,
} from "../math";

import {
  PoolState,
  PositionState,
  ObservationState,
  AmmConfig,
  PositionRewardInfo,
  RewardInfo,
} from "../states";

import {
  getAmmConfigAddress,
  getPoolAddress,
  getPoolVaultAddress,
  getProtocolPositionAddress,
  getNftMetadataAddress,
  getPersonalPositionAddress,
  getTickArrayAddress,
} from "../utils";

import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  openPositionInstruction,
  closePositionInstruction,
  createPoolInstruction,
  increaseLiquidityInstruction,
  decreaseLiquidityInstruction,
  swapInstruction,
  swapRouterBaseInInstruction,
} from "./user";
import {
  createAmmConfigInstruction,
  updateAmmConfigInstruction,
} from "./admin";

import { AmmPool } from "../pool";
import { Context } from "../base";
import Decimal from "decimal.js";

type CreatePoolAccounts = {
  poolCreator: PublicKey;
  ammConfig: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  observation: PublicKey;
};

export type OpenPositionAccounts = {
  payer: PublicKey;
  positionNftOwner: PublicKey;
  positionNftMint: PublicKey;
  token0Account: PublicKey;
  token1Account: PublicKey;
};

export type ClosePositionAccounts = {
  nftOwner: PublicKey;
  nftAccount: PublicKey;
  positionNftMint: PublicKey;
  personalPosition: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
};

export type IncreaseLiquidityAccounts = {
  positionNftOwner: PublicKey;
  token0Account: PublicKey;
  token1Account: PublicKey;
};

export type DecreaseLiquidityAccounts = {
  positionNftOwner: PublicKey;
  token0Account: PublicKey;
  token1Account: PublicKey;
  // recipientRewardTokenAccountA: PublicKey[];
};

export type SwapAccounts = {
  payer: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
};

export type RouterPoolParam = {
  ammPool: AmmPool;
  inputTokenMint: PublicKey;
};

type PrepareOnePoolResult = {
  amountOut: BN;
  inputTokenAccount: PublicKey;
  outputTokenMint: PublicKey;
  outputTokenAccount: PublicKey;
  remains: AccountMeta[];
};

export class AmmInstruction {
  private constructor() {}

  /**
   *
   * @param ctx
   * @param owner
   * @param index
   * @param tickSpacing
   * @param tradeFeeRate
   * @param protocolFeeRate
   * @returns
   */
  public static async createAmmConfig(
    ctx: Context,
    owner: PublicKey,
    index: number,
    tickSpacing: number,
    tradeFeeRate: number,
    protocolFeeRate: number
  ): Promise<[PublicKey, TransactionInstruction]> {
    const [address, _] = await getAmmConfigAddress(
      index,
      ctx.program.programId
    );
    return [
      address,
      await createAmmConfigInstruction(
        ctx.program,
        {
          index,
          tickSpacing,
          tradeFeeRate: tradeFeeRate,
          protocolFeeRate,
        },
        {
          owner: owner,
          ammConfig: address,
          systemProgram: SystemProgram.programId,
        }
      ),
    ];
  }

  public static async setAmmConfigNewOwner(
    ctx: Context,
    ammConfig: PublicKey,
    owner: PublicKey,
    newOwner: PublicKey,
    tradeFeeRate: number,
    protocolFeeRate: number
  ): Promise<TransactionInstruction> {
    return await updateAmmConfigInstruction(
      ctx.program,
      {
        newOwner,
        tradeFeeRate: 0,
        protocolFeeRate: 0,
        flag: 0,
      },
      {
        owner,
        ammConfig,
      }
    );
  }

  public static async setAmmConfigTradeFeeRate(
    ctx: Context,
    ammConfig: PublicKey,
    owner: PublicKey,
    tradeFeeRate: number
  ): Promise<TransactionInstruction> {
    return await updateAmmConfigInstruction(
      ctx.program,
      {
        newOwner: PublicKey.default,
        tradeFeeRate: tradeFeeRate,
        protocolFeeRate: 0,
        flag: 1,
      },
      {
        owner,
        ammConfig,
      }
    );
  }

  public static async setAmmConfigProtocolFeeRate(
    ctx: Context,
    ammConfig: PublicKey,
    owner: PublicKey,
    protocolFeeRate: number
  ): Promise<TransactionInstruction> {
    return await updateAmmConfigInstruction(
      ctx.program,
      {
        newOwner: PublicKey.default,
        tradeFeeRate: 0,
        protocolFeeRate: protocolFeeRate,
        flag: 2,
      },
      {
        owner,
        ammConfig,
      }
    );
  }

  /**
   *
   * @param ctx
   * @param accounts
   * @param initialPrice
   * @returns
   */
  public static async createPool(
    ctx: Context,
    accounts: CreatePoolAccounts,
    initialPrice: Decimal
  ): Promise<[PublicKey, TransactionInstruction]> {
    if (accounts.tokenMint0 >= accounts.tokenMint1) {
      let tmp = accounts.tokenMint0;
      accounts.tokenMint0 = accounts.tokenMint1;
      accounts.tokenMint1 = tmp;
    }
    const [poolAddres, _bump1] = await getPoolAddress(
      accounts.ammConfig,
      accounts.tokenMint0,
      accounts.tokenMint1,
      ctx.program.programId
    );
    const [vault0, _bump2] = await getPoolVaultAddress(
      poolAddres,
      accounts.tokenMint0,
      ctx.program.programId
    );
    const [vault1, _bump3] = await getPoolVaultAddress(
      poolAddres,
      accounts.tokenMint1,
      ctx.program.programId
    );

    const initialPriceX64 = SqrtPriceMath.priceToSqrtPriceX64(initialPrice);
    const creatPoolIx = await createPoolInstruction(
      ctx.program,
      initialPriceX64,
      {
        poolCreator: accounts.poolCreator,
        ammConfig: accounts.ammConfig,
        tokenMint0: accounts.tokenMint0,
        tokenMint1: accounts.tokenMint1,
        poolState: poolAddres,
        observationState: accounts.observation,
        tokenVault0: vault0,
        tokenVault1: vault1,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    );

    return [poolAddres, creatPoolIx];
  }

  /**
   *
   * @param accounts
   * @param ammPool
   * @param priceLower
   * @param priceUpper
   * @param liquidity
   * @param amountSlippage
   * @returns
   */
  public static async openPositionWithPrice(
    accounts: OpenPositionAccounts,
    ammPool: AmmPool,
    priceLower: Decimal,
    priceUpper: Decimal,
    liquidity: BN,
    amountSlippage?: number
  ): Promise<[PublicKey, TransactionInstruction]> {
    const tickLower = SqrtPriceMath.getTickFromPrice(priceLower);
    const tickUpper = SqrtPriceMath.getTickFromPrice(priceUpper);

    return AmmInstruction.openPosition(
      accounts,
      ammPool,
      tickLower,
      tickUpper,
      liquidity,
      amountSlippage
    );
  }

  /**
   *
   * @param accounts
   * @param ammPool
   * @param tickLowerIndex
   * @param tickUpperIndex
   * @param liquidity
   * @param amountSlippage
   * @returns
   */
  public static async openPosition(
    accounts: OpenPositionAccounts,
    ammPool: AmmPool,
    tickLowerIndex: number,
    tickUpperIndex: number,
    liquidity: BN,
    amountSlippage?: number
  ): Promise<[PublicKey, TransactionInstruction]> {
    if (amountSlippage != undefined && amountSlippage < 0) {
      throw new Error("amountSlippage must be gtn 0");
    }
    if (tickLowerIndex % ammPool.poolState.tickSpacing != 0) {
      throw new Error(
        "tickLowIndex must be an integer multiple of tickspacing"
      );
    }
    if (tickUpperIndex % ammPool.poolState.tickSpacing != 0) {
      throw new Error(
        "tickUpperIndex must be an integer multiple of tickspacing"
      );
    }

    const poolState = ammPool.poolState;
    const ctx = ammPool.ctx;
    const [token0Amount, token1Amount] = LiquidityMath.getAmountsFromLiquidity(
      poolState.sqrtPriceX64,
      SqrtPriceMath.getSqrtPriceX64FromTick(tickLowerIndex),
      SqrtPriceMath.getSqrtPriceX64FromTick(tickUpperIndex),
      liquidity
    );
    let amount0Max = token0Amount;
    let amount1Max = token1Amount;
    if (amountSlippage !== undefined) {
      amount0Max = token0Amount.muln(1 + amountSlippage);
      amount1Max = token1Amount.muln(1 + amountSlippage);
    }
    // prepare tickArray
    const tickArrayLowerStartIndex = getTickArrayStartIndexByTick(
      tickLowerIndex,
      ammPool.poolState.tickSpacing
    );
    const [tickArrayLower] = await getTickArrayAddress(
      ammPool.address,
      ctx.program.programId,
      tickArrayLowerStartIndex
    );
    const tickArrayUpperStartIndex = getTickArrayStartIndexByTick(
      tickUpperIndex,
      ammPool.poolState.tickSpacing
    );
    const [tickArrayUpper] = await getTickArrayAddress(
      ammPool.address,
      ctx.program.programId,
      tickArrayUpperStartIndex
    );
    const positionANftAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      accounts.positionNftMint,
      accounts.positionNftOwner
    );

    const metadataAccount = (
      await getNftMetadataAddress(accounts.positionNftMint)
    )[0];

    const [personalPosition] = await getPersonalPositionAddress(
      accounts.positionNftMint,
      ctx.program.programId
    );

    const [protocolPosition] = await getProtocolPositionAddress(
      ammPool.address,
      ctx.program.programId,
      tickLowerIndex,
      tickUpperIndex
    );

    return [
      personalPosition,
      await openPositionInstruction(
        ctx.program,
        {
          tickLowerIndex,
          tickUpperIndex,
          tickArrayLowerStartIndex: tickArrayLowerStartIndex,
          tickArrayUpperStartIndex: tickArrayUpperStartIndex,
          liquidity: liquidity,
          amount0Max: amount0Max,
          amount1Max: amount1Max,
        },
        {
          payer: accounts.payer,
          positionNftOwner: accounts.positionNftOwner,
          ammConfig: poolState.ammConfig,
          positionNftMint: accounts.positionNftMint,
          positionNftAccount: positionANftAccount,
          metadataAccount,
          poolState: ammPool.address,
          protocolPosition,
          tickArrayLower,
          tickArrayUpper,
          tokenAccount0: accounts.token0Account,
          tokenAccount1: accounts.token1Account,
          tokenVault0: poolState.tokenVault0,
          tokenVault1: poolState.tokenVault1,
          personalPosition,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          metadataProgram: programs.metadata.MetadataProgram.PUBKEY,
        }
      ),
    ];
  }
  public static async closePosition(
    accounts: ClosePositionAccounts,
    ammPool: AmmPool
  ): Promise<TransactionInstruction> {
    return closePositionInstruction(ammPool.ctx.program, accounts);
  }

  /**
   *
   * @param accounts
   * @param ammPool
   * @param positionState
   * @param liquidity
   * @param amountSlippage
   * @returns
   */
  public static async increaseLiquidity(
    accounts: IncreaseLiquidityAccounts,
    ammPool: AmmPool,
    positionState: PositionState,
    liquidity: BN,
    amountSlippage?: number
  ): Promise<TransactionInstruction> {
    if (amountSlippage != undefined && amountSlippage < 0) {
      throw new Error("amountSlippage must be gtn 0");
    }
    const poolState = ammPool.poolState;
    const ctx = ammPool.ctx;
    const tickLowerIndex = positionState.tickLowerIndex;
    const tickUpperIndex = positionState.tickUpperIndex;

    const [token0Amount, token1Amount] = LiquidityMath.getAmountsFromLiquidity(
      poolState.sqrtPriceX64,
      SqrtPriceMath.getSqrtPriceX64FromTick(tickLowerIndex),
      SqrtPriceMath.getSqrtPriceX64FromTick(tickUpperIndex),
      liquidity
    );
    let amount0Max = token0Amount;
    let amount1Max = token1Amount;
    if (amountSlippage != undefined) {
      amount0Max = token0Amount.muln(1 + amountSlippage);
      amount1Max = token1Amount.muln(1 + amountSlippage);
    }
    // prepare tickArray
    const tickArrayLowerStartIndex = getTickArrayStartIndexByTick(
      tickLowerIndex,
      ammPool.poolState.tickSpacing
    );
    const [tickArrayLower] = await getTickArrayAddress(
      ammPool.address,
      ctx.program.programId,
      tickArrayLowerStartIndex
    );
    const tickArrayUpperStartIndex = getTickArrayStartIndexByTick(
      tickUpperIndex,
      ammPool.poolState.tickSpacing
    );
    const [tickArrayUpper] = await getTickArrayAddress(
      ammPool.address,
      ctx.program.programId,
      tickArrayUpperStartIndex
    );

    const positionANftAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      positionState.nftMint,
      accounts.positionNftOwner
    );

    const [personalPosition] = await getPersonalPositionAddress(
      positionState.nftMint,
      ctx.program.programId
    );

    const [protocolPosition] = await getProtocolPositionAddress(
      ammPool.address,
      ctx.program.programId,
      tickLowerIndex,
      tickUpperIndex
    );

    return await increaseLiquidityInstruction(
      ctx.program,
      {
        liquidity,
        amount0Max,
        amount1Max,
      },
      {
        nftOwner: accounts.positionNftOwner,
        nftAccount: positionANftAccount,
        poolState: ammPool.address,
        protocolPosition,
        tickArrayLower,
        tickArrayUpper,
        tokenAccount0: accounts.token0Account,
        tokenAccount1: accounts.token1Account,
        tokenVault0: poolState.tokenVault0,
        tokenVault1: poolState.tokenVault1,
        personalPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    );
  }

  /**
   *  decrease liquidity, collect fee and rewards
   * @param accounts
   * @param ammPool
   * @param positionState
   * @param token0AmountDesired
   * @param token1AmountDesired
   * @param amountSlippage
   * @returns
   */
  public static async decreaseLiquidityWithInputAmount(
    accounts: DecreaseLiquidityAccounts,
    ammPool: AmmPool,
    positionState: PositionState,
    token0AmountDesired: BN,
    token1AmountDesired: BN,
    amountSlippage?: number
  ): Promise<TransactionInstruction> {
    if (amountSlippage != undefined && amountSlippage < 0) {
      throw new Error("amountSlippage must be gtn 0");
    }
    const price_lower = SqrtPriceMath.getSqrtPriceX64FromTick(
      positionState.tickLowerIndex
    );
    const price_upper = SqrtPriceMath.getSqrtPriceX64FromTick(
      positionState.tickUpperIndex
    );
    const liquidity = LiquidityMath.getLiquidityFromTokenAmounts(
      ammPool.poolState.sqrtPriceX64,
      price_lower,
      price_upper,
      token0AmountDesired,
      token1AmountDesired
    );
    return AmmInstruction.decreaseLiquidity(
      accounts,
      ammPool,
      positionState,
      liquidity,
      amountSlippage
    );
  }

  /**
   * decrease liquidity, collect fee and rewards
   * @param accounts
   * @param ammPool
   * @param positionState
   * @param liquidity
   * @param amountSlippage
   * @returns
   */
  public static async decreaseLiquidity(
    accounts: DecreaseLiquidityAccounts,
    ammPool: AmmPool,
    positionState: PositionState,
    liquidity: BN,
    amountSlippage?: number
  ): Promise<TransactionInstruction> {
    if (amountSlippage != undefined && amountSlippage < 0) {
      throw new Error("amountSlippage must be gtn 0");
    }
    const ctx = ammPool.ctx;
    const tickLowerIndex = positionState.tickLowerIndex;
    const tickUpperIndex = positionState.tickUpperIndex;
    const sqrtPriceLowerX64 =
      SqrtPriceMath.getSqrtPriceX64FromTick(tickLowerIndex);
    const sqrtPriceUpperX64 =
      SqrtPriceMath.getSqrtPriceX64FromTick(tickUpperIndex);

    const [token0Amount, token1Amount] = LiquidityMath.getAmountsFromLiquidity(
      ammPool.poolState.sqrtPriceX64,
      sqrtPriceLowerX64,
      sqrtPriceUpperX64,
      liquidity
    );
    let amount0Min: BN = new BN(0);
    let amount1Min: BN = new BN(0);
    if (amountSlippage !== undefined) {
      amount0Min = token0Amount.muln(1 - amountSlippage);
      amount1Min = token1Amount.muln(1 - amountSlippage);
    }
    // prepare tickArray
    const tickArrayLowerStartIndex = getTickArrayStartIndexByTick(
      tickLowerIndex,
      ammPool.poolState.tickSpacing
    );
    const [tickArrayLower] = await getTickArrayAddress(
      ammPool.address,
      ctx.program.programId,
      tickArrayLowerStartIndex
    );
    const tickArrayUpperStartIndex = getTickArrayStartIndexByTick(
      tickUpperIndex,
      ammPool.poolState.tickSpacing
    );
    const [tickArrayUpper] = await getTickArrayAddress(
      ammPool.address,
      ctx.program.programId,
      tickArrayUpperStartIndex
    );

    const positionANftAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      positionState.nftMint,
      accounts.positionNftOwner
    );

    const [personalPosition] = await getPersonalPositionAddress(
      positionState.nftMint,
      ctx.program.programId
    );

    const [protocolPosition] = await getProtocolPositionAddress(
      ammPool.address,
      ctx.program.programId,
      tickLowerIndex,
      tickUpperIndex
    );

    return await decreaseLiquidityInstruction(
      ctx.program,
      {
        liquidity: liquidity,
        amount0Min,
        amount1Min,
      },
      {
        nftOwner: accounts.positionNftOwner,
        nftAccount: positionANftAccount,
        poolState: ammPool.address,
        protocolPosition,
        tickArrayLower,
        tickArrayUpper,
        recipientTokenAccount0: accounts.token0Account,
        recipientTokenAccount1: accounts.token1Account,
        tokenVault0: ammPool.poolState.tokenVault0,
        tokenVault1: ammPool.poolState.tokenVault1,
        personalPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      []
    );
  }

  /**
   *
   * @param accounts
   * @param ammPool
   * @param inputTokenMint
   * @param amountIn
   * @param amountOutSlippage
   * @param priceLimit
   * @returns
   */
  public static async swapBaseIn(
    accounts: SwapAccounts,
    ammPool: AmmPool,
    inputTokenMint: PublicKey,
    amountIn: BN,
    amountOutSlippage?: number,
    priceLimit?: Decimal
  ): Promise<TransactionInstruction> {
    if (amountOutSlippage != undefined && amountOutSlippage < 0) {
      throw new Error("amountOutSlippage must be gtn 0");
    }
    let sqrtPriceLimitX64 = new BN(0);
    const zeroForOne = inputTokenMint.equals(ammPool.poolState.tokenMint0);
    if (priceLimit == undefined || priceLimit.eq(new Decimal(0))) {
      sqrtPriceLimitX64 = zeroForOne
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
    } else {
      sqrtPriceLimitX64 = SqrtPriceMath.priceToSqrtPriceX64(priceLimit);
    }
    const [expectedAmountOut, remainingAccounts] =
      await ammPool.getOutputAmountAndRemainAccounts(
        inputTokenMint,
        amountIn,
        sqrtPriceLimitX64,
        true
      );

    let amountOutMin = new BN(0);
    if (amountOutSlippage != undefined) {
      amountOutMin = expectedAmountOut.muln(1 - amountOutSlippage);
    }
    return AmmInstruction.swap(
      accounts,
      remainingAccounts,
      ammPool,
      inputTokenMint,
      amountIn,
      amountOutMin,
      true,
      sqrtPriceLimitX64
    );
  }

  /**
   *
   * @param accounts
   * @param ammPool
   * @param outputTokenMint
   * @param amountOut
   * @param amountInSlippage
   * @param priceLimit
   * @returns
   */
  public static async swapBaseOut(
    accounts: SwapAccounts,
    ammPool: AmmPool,
    outputTokenMint: PublicKey,
    amountOut: BN,
    amountInSlippage?: number,
    priceLimit?: Decimal
  ): Promise<TransactionInstruction> {
    if (amountInSlippage != undefined && amountInSlippage < 0) {
      throw new Error("amountInSlippage must be gtn 0");
    }
    let sqrtPriceLimitX64 = new BN(0);
    const zeroForOne = outputTokenMint.equals(ammPool.poolState.tokenMint1);
    if (priceLimit == undefined || priceLimit.eq(new Decimal(0))) {
      sqrtPriceLimitX64 = zeroForOne
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
    } else {
      sqrtPriceLimitX64 = SqrtPriceMath.priceToSqrtPriceX64(priceLimit);
    }
    const [expectedAmountIn, remainingAccounts] =
      await ammPool.getInputAmountAndAccounts(
        outputTokenMint,
        amountOut,
        sqrtPriceLimitX64,
        true
      );
    let amountInMax = new BN(1).shln(32);
    if (amountInSlippage != undefined) {
      amountInMax = expectedAmountIn.muln(1 + amountInSlippage);
    }
    return AmmInstruction.swap(
      accounts,
      remainingAccounts,
      ammPool,
      outputTokenMint,
      amountOut,
      amountInMax,
      false,
      sqrtPriceLimitX64
    );
  }

  /**
   *
   * @param payer
   * @param firstPoolParam
   * @param remainRouterPools
   * @param amountIn
   * @param amountOutSlippage
   * @returns
   */
  public static async swapRouterBaseIn(
    payer: PublicKey,
    firstPoolParam: RouterPoolParam,
    remainRouterPools: AmmPool[],
    amountIn: BN,
    amountOutSlippage?: number
  ): Promise<TransactionInstruction> {
    if (amountOutSlippage != undefined && amountOutSlippage < 0) {
      throw new Error("amountOutSlippage must be gtn 0");
    }
    let remainingAccounts: AccountMeta[] = [];

    let result = await AmmInstruction.prepareOnePool(
      payer,
      amountIn,
      firstPoolParam
    );
    remainingAccounts.push(...result.remains);
    const startInputTokenAccount = result.inputTokenAccount;
    for (let i = 0; i < remainRouterPools.length; i++) {
      const param: RouterPoolParam = {
        ammPool: remainRouterPools[i],
        inputTokenMint: result.outputTokenMint,
      };
      result = await AmmInstruction.prepareOnePool(
        payer,
        result.amountOut,
        param
      );
      remainingAccounts.push(...result.remains);
    }
    let amountOutMin = new BN(0);
    if (amountOutSlippage != undefined) {
      amountOutMin = amountOutMin.muln(1 - amountOutSlippage);
    }
    return await swapRouterBaseInInstruction(
      firstPoolParam.ammPool.ctx.program,
      {
        amountIn,
        amountOutMinimum: amountOutMin,
      },
      {
        payer,
        inputTokenAccount: startInputTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        remainings: remainingAccounts,
      }
    );
  }

  static async swap(
    accounts: SwapAccounts,
    remainingAccounts: AccountMeta[],
    ammPool: AmmPool,
    inputTokenMint: PublicKey,
    amount: BN,
    otherAmountThreshold: BN,
    isBaseInput: boolean,
    sqrtPriceLimitX64?: BN
  ): Promise<TransactionInstruction> {
    const poolState = ammPool.poolState;
    const ctx = ammPool.ctx;
    // get vault
    const zeroForOne = isBaseInput
      ? inputTokenMint.equals(poolState.tokenMint0)
      : inputTokenMint.equals(poolState.tokenMint1);

    let inputVault: PublicKey = poolState.tokenVault0;
    let outputVault: PublicKey = poolState.tokenVault1;
    if (!zeroForOne) {
      inputVault = poolState.tokenVault1;
      outputVault = poolState.tokenVault0;
    }
    if (sqrtPriceLimitX64 == undefined) {
      sqrtPriceLimitX64 = new BN(0);
    }
    const tickArray = remainingAccounts[0].pubkey;
    if (remainingAccounts.length > 1) {
      remainingAccounts = remainingAccounts.slice(1, remainingAccounts.length);
    }
    return await swapInstruction(
      ctx.program,
      {
        amount,
        otherAmountThreshold,
        sqrtPriceLimitX64,
        isBaseInput,
      },
      {
        payer: accounts.payer,
        ammConfig: poolState.ammConfig,
        poolState: ammPool.address,
        inputTokenAccount: accounts.inputTokenAccount,
        outputTokenAccount: accounts.outputTokenAccount,
        inputVault,
        outputVault,
        tickArray,
        observationState: ammPool.poolState.observationKey,
        remainings: [...remainingAccounts],
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    );
  }

  static async prepareOnePool(
    owner: PublicKey,
    inputAmount: BN,
    param: RouterPoolParam
  ): Promise<PrepareOnePoolResult> {
    if (!param.ammPool.isContain(param.inputTokenMint)) {
      throw new Error(
        `pool ${param.ammPool.address.toString()} is not contain token mint ${param.inputTokenMint.toString()}`
      );
    }
    // get vault
    const zeroForOne = param.inputTokenMint.equals(
      param.ammPool.poolState.tokenMint0
    );
    let inputVault: PublicKey = param.ammPool.poolState.tokenVault0;
    let outputVault: PublicKey = param.ammPool.poolState.tokenVault1;
    let outputTokenMint: PublicKey = param.ammPool.poolState.tokenMint1;
    if (!zeroForOne) {
      inputVault = param.ammPool.poolState.tokenVault1;
      outputVault = param.ammPool.poolState.tokenVault0;
      outputTokenMint = param.ammPool.poolState.tokenMint0;
    }
    const [expectedAmountOut, remainingAccounts] =
      await param.ammPool.getOutputAmountAndRemainAccounts(
        param.inputTokenMint,
        inputAmount
      );
    if (remainingAccounts.length == 0) {
      throw new Error("must has one tickArray");
    }
    const inputTokenAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      param.inputTokenMint,
      owner
    );

    const outputTokenAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      outputTokenMint,
      owner
    );
    return {
      amountOut: expectedAmountOut,
      inputTokenAccount,
      outputTokenMint,
      outputTokenAccount,
      remains: [
        {
          pubkey: param.ammPool.poolState.ammConfig,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: param.ammPool.address,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: outputTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: inputVault,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: outputVault,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: param.ammPool.poolState.observationKey,
          isSigner: false,
          isWritable: true,
        },
        ...remainingAccounts,
      ],
    };
  }
}
