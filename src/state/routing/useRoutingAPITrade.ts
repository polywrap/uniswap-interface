import { PolywrapClient } from '@polywrap/client-js'
import { usePolywrapClient } from '@polywrap/react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { Currency, CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core'
import { useStablecoinAmountFromFiatValue } from 'hooks/useUSDCPrice'
import ms from 'ms.macro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlockNumber } from 'state/application/hooks'
import { useGetQuoteQuery } from 'state/routing/slice'
import { useClientSideRouter } from 'state/user/hooks'

import { ExtendedTrade } from '../../polywrap-utils/interfaces'
import { CancelablePromise, makeCancelable } from '../../polywrap-utils/makeCancelable'
import { GetQuoteResult, TradeState } from './types'
import { computeRoutes, transformRoutesToTrade } from './utils'

function useFreshData<T>(data: T, dataBlockNumber: number, maxBlockAge = 10): T | undefined {
  const localBlockNumber = useBlockNumber()

  if (!localBlockNumber) return undefined
  if (localBlockNumber - dataBlockNumber > maxBlockAge) {
    return undefined
  }

  return data
}

/**
 * Returns query arguments for the Routing API query or undefined if the
 * query should be skipped.
 */
function useRoutingAPIArguments({
  tokenIn,
  tokenOut,
  amount,
  tradeType,
}: {
  tokenIn: Currency | undefined
  tokenOut: Currency | undefined
  amount: CurrencyAmount<Currency> | undefined
  tradeType: TradeType
}) {
  const [clientSideRouter] = useClientSideRouter()

  return useMemo(
    () =>
      !tokenIn || !tokenOut || !amount || tokenIn.equals(tokenOut)
        ? undefined
        : {
            amount: amount.quotient.toString(),
            tokenInAddress: tokenIn.wrapped.address,
            tokenInChainId: tokenIn.wrapped.chainId,
            tokenInDecimals: tokenIn.wrapped.decimals,
            tokenInSymbol: tokenIn.wrapped.symbol,
            tokenOutAddress: tokenOut.wrapped.address,
            tokenOutChainId: tokenOut.wrapped.chainId,
            tokenOutDecimals: tokenOut.wrapped.decimals,
            tokenOutSymbol: tokenOut.wrapped.symbol,
            useClientSideRouter: clientSideRouter,
            type: (tradeType === TradeType.EXACT_INPUT ? 'exactIn' : 'exactOut') as 'exactIn' | 'exactOut',
          },
    [amount, clientSideRouter, tokenIn, tokenOut, tradeType]
  )
}

/**
 * Returns the best trade by invoking the routing api or the smart order router on the client
 * @param tradeType whether the swap is an exact in/out
 * @param amountSpecified the exact amount to swap in/out
 * @param otherCurrency the desired output/payment currency
 */
export function useRoutingAPITrade<TTradeType extends TradeType>(
  tradeType: TTradeType,
  amountSpecified?: CurrencyAmount<Currency>,
  otherCurrency?: Currency
): {
  state: TradeState
  trade?: ExtendedTrade
  gasUseEstimateUSD?: CurrencyAmount<Token> | null
} {
  const [currencyIn, currencyOut]: [Currency | undefined, Currency | undefined] = useMemo(
    () =>
      tradeType === TradeType.EXACT_INPUT
        ? [amountSpecified?.currency, otherCurrency]
        : [otherCurrency, amountSpecified?.currency],
    [amountSpecified, otherCurrency, tradeType]
  )

  const queryArgs = useRoutingAPIArguments({
    tokenIn: currencyIn,
    tokenOut: currencyOut,
    amount: amountSpecified,
    tradeType,
  })

  const { isLoading, isError, data } = useGetQuoteQuery(queryArgs ?? skipToken, {
    pollingInterval: ms`15s`,
    refetchOnFocus: true,
  })

  const quoteResult: GetQuoteResult | undefined = useFreshData(data, Number(data?.blockNumber) || 0)

  const client: PolywrapClient = usePolywrapClient()

  // get USD gas cost of trade in active chains stablecoin amount
  const gasUseEstimateUSD = useStablecoinAmountFromFiatValue(quoteResult?.gasUseEstimateUSD) ?? null

  const [tradeResult, setTradeResult] = useState<{
    state: TradeState
    trade?: ExtendedTrade
    gasUseEstimateUSD?: CurrencyAmount<Token> | null
  }>({
    state: TradeState.LOADING,
  })
  const cancelable =
    useRef<
      CancelablePromise<
        { state: TradeState; trade?: ExtendedTrade; gasUseEstimateUSD?: CurrencyAmount<Token> | null } | undefined
      >
    >()

  useEffect(() => {
    cancelable.current?.cancel()
    if (!currencyIn || !currencyOut) {
      setTradeResult({
        state: TradeState.INVALID,
        trade: undefined,
      })
      return
    }

    if (isLoading && !quoteResult) {
      // only on first hook render
      setTradeResult({
        state: TradeState.LOADING,
        trade: undefined,
      })
      return
    }

    const otherAmount =
      tradeType === TradeType.EXACT_INPUT
        ? currencyOut && quoteResult
          ? CurrencyAmount.fromRawAmount(currencyOut, quoteResult.quote)
          : undefined
        : currencyIn && quoteResult
        ? CurrencyAmount.fromRawAmount(currencyIn, quoteResult.quote)
        : undefined

    if (isError || !otherAmount || !queryArgs) {
      setTradeResult({
        state: TradeState.NO_ROUTE_FOUND,
        trade: undefined,
      })
      return
    }

    const tradePromise = loadTrade(client, currencyIn, currencyOut, tradeType, quoteResult, gasUseEstimateUSD)
    cancelable.current = makeCancelable(tradePromise)
    cancelable.current?.promise.then((res) => {
      if (!res) return
      setTradeResult(res)
    })
    return () => cancelable.current?.cancel()
  }, [
    currencyIn,
    currencyOut,
    isLoading,
    quoteResult,
    tradeType,
    isError,
    queryArgs,
    gasUseEstimateUSD?.toFixed(),
    client,
  ])

  return tradeResult
}

const loadTrade = async (
  client: PolywrapClient,
  currencyIn: Currency,
  currencyOut: Currency,
  tradeType: TradeType,
  quoteResult: GetQuoteResult | undefined,
  gasUseEstimateUSD: CurrencyAmount<Token> | null
): Promise<{ state: TradeState; trade?: ExtendedTrade; gasUseEstimateUSD?: CurrencyAmount<Token> | null }> => {
  const route = await computeRoutes(client, currencyIn, currencyOut, tradeType, quoteResult)

  if (!route || route.length === 0) {
    return {
      state: TradeState.NO_ROUTE_FOUND,
      trade: undefined,
    }
  }

  try {
    const trade = await transformRoutesToTrade(client, route, tradeType, gasUseEstimateUSD)
    if (!trade) {
      console.debug('transformRoutesToTrade returned undefined')
      return { state: TradeState.INVALID, trade: undefined, gasUseEstimateUSD }
    }
    return {
      // always return VALID regardless of isFetching status
      state: TradeState.VALID,
      trade,
    }
  } catch (e) {
    console.debug('transformRoutesToTrade failed: ', e)
    return { state: TradeState.INVALID, trade: undefined, gasUseEstimateUSD }
  }
}
