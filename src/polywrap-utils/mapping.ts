import {
  Currency as UniCurrency,
  CurrencyAmount as UniCurrencyAmount,
  Price as UniPrice,
  Token as UniToken,
  TradeType as UniTradeType,
} from '@uniswap/sdk-core'

import {
  Uni_ChainIdEnum as ChainIdEnum,
  Uni_Currency as Currency,
  Uni_FeeAmountEnum as FeeAmountEnum,
  Uni_Price as Price,
  Uni_Token as Token,
  Uni_TokenAmount as TokenAmount,
  Uni_TradeTypeEnum as TradeTypeEnum,
} from '../polywrap'
import { ETHER } from './constants'
import { currencyEquals } from './utils'

export function mapChainId(input: number): ChainIdEnum {
  switch (input) {
    case 1:
      return ChainIdEnum.MAINNET
    case 3:
      return ChainIdEnum.ROPSTEN
    case 4:
      return ChainIdEnum.RINKEBY
    case 5:
      return ChainIdEnum.GOERLI
    case 42:
      return ChainIdEnum.KOVAN
    default:
      throw new Error('Unknown chain ID. This should never happen.')
  }
}

export function mapCurrency(input: UniCurrency): Currency {
  return {
    decimals: input.decimals,
    symbol: input.symbol,
    name: input.name,
  }
}

export function mapToken(input: UniToken | UniCurrency, backupChainId?: number): Token {
  const currency = mapCurrency(input)
  if (input instanceof UniToken) {
    return {
      chainId: mapChainId(input.chainId),
      address: currencyEquals(currency, ETHER) ? '' : input.address,
      currency,
    }
  }
  return {
    chainId: backupChainId ? mapChainId(backupChainId) : 999,
    address: '',
    currency,
  }
}

export function mapTokenAmount<T extends UniCurrency>(
  input?: UniCurrencyAmount<T>,
  backupChainId?: number
): TokenAmount | undefined {
  if (!input) return undefined
  return {
    token: mapToken(input.currency, backupChainId),
    amount: input.numerator.toString(),
  }
}

export function mapFeeAmount(input: string | number): FeeAmountEnum {
  switch (input) {
    case 100:
    case '100':
      return FeeAmountEnum.LOWEST
    case 500:
    case '500':
      return FeeAmountEnum.LOW
    case 3000:
    case '3000':
      return FeeAmountEnum.MEDIUM
    case 10000:
    case '10000':
      return FeeAmountEnum.HIGH
    default:
      throw Error('unknown fee amount')
  }
}

// export async function mapTicks(provider: UniTickDataProvider, spacing: number): Promise<Tick[]> {
//   const ticks: Tick[] = []
//   for (
//     let i = TickMath.MIN_TICK - 1;
//     i < TickMath.MAX_TICK;
//     i = (await provider.nextInitializedTickWithinOneWord(i, false, spacing))[0]
//   ) {
//     const uniTick: UniTick = (await provider.getTick(i)) as UniTick
//     ticks.push({
//       index: uniTick.index,
//       liquidityGross: uniTick.liquidityGross.toString(),
//       liquidityNet: uniTick.liquidityNet.toString(),
//     })
//   }
//   return ticks
// }

// export async function mapPool(input: UniPool): Promise<Pool> {
//   return {
//     token0: mapToken(input.token0),
//     token1: mapToken(input.token1),
//     fee: mapFeeAmount(input.fee),
//     sqrtRatioX96: input.sqrtRatioX96.toString(),
//     liquidity: input.liquidity.toString(),
//     tickCurrent: input.tickCurrent,
//     tickDataProvider: await mapTicks(input.tickDataProvider, input.tickSpacing),
//     token0Price: mapPrice(input.token0Price),
//     token1Price: mapPrice(input.token1Price),
//   }
// }
//
// export async function mapPools(input: UniPool[]): Promise<Pool[]> {
//   return Promise.all(input.map(mapPool))
// }

// export async function mapPosition(input: UniPosition): Promise<Position> {
//   return {
//     pool: await mapPool(input.pool),
//     tickLower: input.tickLower,
//     tickUpper: input.tickUpper,
//     liquidity: input.liquidity.toString(),
//     token0Amount: mapTokenAmount(input.amount0),
//     token1Amount: mapTokenAmount(input.amount1),
//
//   }
// }

// export async function mapRoute<TIn extends UniCurrency, TOut extends UniCurrency>(
//   input: UniRoute<TIn, TOut>
// ): Promise<Route> {
//   return {
//     pools: await mapPools(input.pools),
//     path: input.tokenPath.map(mapToken),
//     input: mapToken(input.input),
//     output: mapToken(input.output),
//   }
// }

export function mapTradeType(input: UniTradeType): TradeTypeEnum {
  if (input === UniTradeType.EXACT_OUTPUT) {
    return TradeTypeEnum.EXACT_OUTPUT
  }
  return TradeTypeEnum.EXACT_INPUT
}

// export async function mapTrade<TIn extends UniCurrency, TOut extends UniCurrency, TType extends UniTradeType>(
//   input: UniTrade<TIn, TOut, TType>
// ): Promise<Trade> {
//   const swapPromises = input.swaps.map(async (swap) => ({
//     route: await mapRoute(swap.route),
//     inputAmount: mapTokenAmount(swap.inputAmount)!,
//     outputAmount: mapTokenAmount(swap.outputAmount)!,
//   }))
//   const executionPrice = {
//     baseToken: mapToken(input.executionPrice.baseCurrency),
//     quoteToken: mapToken(input.executionPrice.quoteCurrency),
//     denominator: input.executionPrice.denominator.toString(),
//     numerator: input.executionPrice.numerator.toString(),
//     price: input.executionPrice.toFixed(19),
//   }
//   return {
//     swaps: await Promise.all(swapPromises),
//     tradeType: mapTradeType(input.tradeType),
//     inputAmount: mapTokenAmount(input.inputAmount)!,
//     outputAmount: mapTokenAmount(input.outputAmount)!,
//     executionPrice,
//     priceImpact: input.priceImpact.toFixed(19),
//   }
// }

export function mapPrice<TBase extends UniCurrency, TQuote extends UniCurrency>(price: UniPrice<TBase, TQuote>): Price {
  return {
    baseToken: mapToken(price.baseCurrency),
    quoteToken: mapToken(price.quoteCurrency),
    denominator: price.denominator.toString(),
    numerator: price.numerator.toString(),
    price: price.toFixed(18),
  }
}
