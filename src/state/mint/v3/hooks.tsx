import { Trans } from '@lingui/macro'
import { InvokeResult, PolywrapClient } from '@polywrap/client-js'
import { usePolywrapClient } from '@polywrap/react'
import { Currency, CurrencyAmount, Price, Rounding, Token } from '@uniswap/sdk-core'
import { useWeb3React } from '@web3-react/core'
import { usePool } from 'hooks/usePools'
import JSBI from 'jsbi'
import tryParseCurrencyAmount from 'lib/utils/tryParseCurrencyAmount'
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppDispatch, useAppSelector } from 'state/hooks'
import { getTickToPrice } from 'utils/getTickToPrice'
import { replaceURLParam } from 'utils/routes'

import { BIG_INT_ZERO } from '../../../constants/misc'
import { PoolState } from '../../../hooks/usePools'
import { mapPrice, mapToken, reverseMapPrice, reverseMapToken, tokenEquals } from '../../../polywrap-utils'
import { CancelablePromise, makeCancelable } from '../../../polywrap-utils/makeCancelable'
import {
  Uni_FeeAmountEnum as FeeAmountEnum,
  Uni_FeeAmountEnum,
  Uni_Module,
  Uni_Pool as Pool,
  Uni_Pool,
  Uni_Position as Position,
  Uni_Price,
} from '../../../wrap'
import { useCurrencyBalances } from '../../connection/hooks'
import { AppState } from '../../index'
import {
  Bound,
  Field,
  setFullRange,
  typeInput,
  typeLeftRangeInput,
  typeRightRangeInput,
  typeStartPriceInput,
} from './actions'
import { tryParseTick } from './utils'

export function useV3MintState(): AppState['mintV3'] {
  return useAppSelector((state) => state.mintV3)
}

export function useV3MintActionHandlers(noLiquidity: boolean | undefined): {
  onFieldAInput: (typedValue: string) => void
  onFieldBInput: (typedValue: string) => void
  onLeftRangeInput: (typedValue: string) => void
  onRightRangeInput: (typedValue: string) => void
  onStartPriceInput: (typedValue: string) => void
} {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const onFieldAInput = useCallback(
    (typedValue: string) => {
      dispatch(typeInput({ field: Field.CURRENCY_A, typedValue, noLiquidity: noLiquidity === true }))
    },
    [dispatch, noLiquidity]
  )

  const onFieldBInput = useCallback(
    (typedValue: string) => {
      dispatch(typeInput({ field: Field.CURRENCY_B, typedValue, noLiquidity: noLiquidity === true }))
    },
    [dispatch, noLiquidity]
  )

  const { search } = useLocation()

  const onLeftRangeInput = useCallback(
    (typedValue: string) => {
      dispatch(typeLeftRangeInput({ typedValue }))
      navigate({ search: replaceURLParam(search, 'minPrice', typedValue) }, { replace: true })
    },
    [dispatch, navigate, search]
  )

  const onRightRangeInput = useCallback(
    (typedValue: string) => {
      dispatch(typeRightRangeInput({ typedValue }))
      navigate({ search: replaceURLParam(search, 'maxPrice', typedValue) }, { replace: true })
    },
    [dispatch, navigate, search]
  )

  const onStartPriceInput = useCallback(
    (typedValue: string) => {
      dispatch(typeStartPriceInput({ typedValue }))
    },
    [dispatch]
  )

  return {
    onFieldAInput,
    onFieldBInput,
    onLeftRangeInput,
    onRightRangeInput,
    onStartPriceInput,
  }
}

const loadMockPool = async (
  price: Price<Token, Token> | undefined,
  feeAmount: FeeAmountEnum | undefined,
  tokenA: Token | undefined,
  tokenB: Token | undefined,
  client: PolywrapClient
) => {
  // invalidPrice
  let invalidPrice
  try {
    let sqrtRatioX96 = undefined
    if (price) {
      const invoke = await Uni_Module.encodeSqrtRatioX96(
        {
          amount1: price.numerator.toString(),
          amount0: price.denominator.toString(),
        },
        client
      )
      if (invoke.error) throw invoke.error
      sqrtRatioX96 = invoke.data as string
    }

    const minSqrtRatioInvoke = await Uni_Module.MIN_SQRT_RATIO({}, client)
    if (minSqrtRatioInvoke.error) throw minSqrtRatioInvoke.error
    const minSqrtRatio = minSqrtRatioInvoke.data as string
    const maxSqrtRatioInvoke = await Uni_Module.MAX_SQRT_RATIO({}, client)
    if (maxSqrtRatioInvoke.error) throw maxSqrtRatioInvoke.error
    const maxSqrtRatio = maxSqrtRatioInvoke.data as string
    invalidPrice =
      price &&
      sqrtRatioX96 &&
      !(
        JSBI.greaterThanOrEqual(JSBI.BigInt(sqrtRatioX96), JSBI.BigInt(minSqrtRatio)) &&
        JSBI.lessThan(JSBI.BigInt(sqrtRatioX96), JSBI.BigInt(maxSqrtRatio))
      )
  } catch {
    invalidPrice = undefined
  }
  // mockPool
  let mockPool: Pool | undefined = undefined
  try {
    if (tokenA && tokenB && feeAmount !== undefined && price && !invalidPrice) {
      const tickInvoke = await Uni_Module.priceToClosestTick({ price: mapPrice(price) }, client)
      if (tickInvoke.error) throw tickInvoke.error
      const currentTick = tickInvoke.data as number
      const sqrtInvoke = await Uni_Module.getSqrtRatioAtTick({ tick: currentTick }, client)
      if (sqrtInvoke.error) throw sqrtInvoke.error
      const currentSqrt = sqrtInvoke.data as string
      const mockPoolInvoke = await Uni_Module.createPool(
        {
          tokenA: mapToken(tokenA),
          tokenB: mapToken(tokenB),
          fee: feeAmount,
          sqrtRatioX96: currentSqrt,
          liquidity: '0',
          tickCurrent: currentTick,
        },
        client
      )
      if (mockPoolInvoke.error) throw mockPoolInvoke.error
      mockPool = mockPoolInvoke.data as Uni_Pool
    }
  } catch {
    mockPool = undefined
  }
  return {
    invalidPrice,
    mockPool,
  }
}

const loadTickSpaceLimits = async (client: PolywrapClient, feeAmount: Uni_FeeAmountEnum) => {
  try {
    const minTickInvoke = await Uni_Module.MIN_TICK({}, client)
    if (minTickInvoke.error) throw minTickInvoke.error
    const minTick = minTickInvoke.data as number

    const maxTickInvoke = await Uni_Module.MAX_TICK({}, client)
    if (maxTickInvoke.error) throw maxTickInvoke.error
    const maxTick = maxTickInvoke.data as number

    const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
    if (tickSpacingInvoke.error) throw tickSpacingInvoke.error
    const tickSpacing = tickSpacingInvoke.data as number

    const lowerInvoke = await Uni_Module.nearestUsableTick(
      {
        tick: minTick,
        tickSpacing,
      },
      client
    )
    if (lowerInvoke.error) throw lowerInvoke.error
    const lower: number = lowerInvoke.data as number

    const upperInvoke = await Uni_Module.nearestUsableTick(
      {
        tick: maxTick,
        tickSpacing,
      },
      client
    )
    if (upperInvoke.error) throw upperInvoke.error
    const upper: number = upperInvoke.data as number

    return {
      [Bound.LOWER]: lower,
      [Bound.UPPER]: upper,
    }
  } catch {
    return {}
  }
}

const loadTicks = async (
  existingPosition: Position | undefined,
  feeAmount: FeeAmountEnum | undefined,
  invertPrice: boolean,
  leftRangeTypedValue: string | true,
  rightRangeTypedValue: string | true,
  token0: Token | undefined,
  token1: Token | undefined,
  tickSpaceLimits: { LOWER?: number; UPPER?: number },
  client: PolywrapClient
) => {
  return {
    [Bound.LOWER]:
      typeof existingPosition?.tickLower === 'number'
        ? existingPosition.tickLower
        : (invertPrice && typeof rightRangeTypedValue === 'boolean') ||
          (!invertPrice && typeof leftRangeTypedValue === 'boolean')
        ? tickSpaceLimits[Bound.LOWER]
        : invertPrice
        ? await tryParseTick(client, token1, token0, feeAmount, rightRangeTypedValue.toString())
        : await tryParseTick(client, token0, token1, feeAmount, leftRangeTypedValue.toString()),
    [Bound.UPPER]:
      typeof existingPosition?.tickUpper === 'number'
        ? existingPosition.tickUpper
        : (!invertPrice && typeof rightRangeTypedValue === 'boolean') ||
          (invertPrice && typeof leftRangeTypedValue === 'boolean')
        ? tickSpaceLimits[Bound.UPPER]
        : invertPrice
        ? await tryParseTick(client, token1, token0, feeAmount, leftRangeTypedValue.toString())
        : await tryParseTick(client, token0, token1, feeAmount, rightRangeTypedValue.toString()),
  }
}

export function useV3DerivedMintInfo(
  currencyA?: Currency,
  currencyB?: Currency,
  feeAmount?: FeeAmountEnum,
  baseCurrency?: Currency,
  // override for existing position
  existingPosition?: Position
): {
  pool?: Pool | null
  poolState: PoolState
  ticks: { [bound in Bound]?: number | undefined }
  price?: Price<Token, Token>
  pricesAtTicks: {
    [bound in Bound]?: Price<Token, Token> | undefined
  }
  currencies: { [field in Field]?: Currency }
  currencyBalances: { [field in Field]?: CurrencyAmount<Currency> }
  dependentField: Field
  parsedAmounts: { [field in Field]?: CurrencyAmount<Currency> }
  position: Position | undefined
  noLiquidity?: boolean
  errorMessage?: ReactNode
  invalidPool: boolean
  outOfRange: boolean
  invalidRange: boolean
  depositADisabled: boolean
  depositBDisabled: boolean
  invertPrice: boolean
  ticksAtLimit: { [bound in Bound]?: boolean | undefined }
} {
  const { account } = useWeb3React()
  const client: PolywrapClient = usePolywrapClient()

  const { independentField, typedValue, leftRangeTypedValue, rightRangeTypedValue, startPriceTypedValue } =
    useV3MintState()

  const dependentField = independentField === Field.CURRENCY_A ? Field.CURRENCY_B : Field.CURRENCY_A

  // currencies
  const currencies: { [field in Field]?: Currency } = useMemo(
    () => ({
      [Field.CURRENCY_A]: currencyA,
      [Field.CURRENCY_B]: currencyB,
    }),
    [currencyA, currencyB]
  )

  // formatted with tokens
  const [tokenA, tokenB, baseToken] = useMemo(
    () => [currencyA?.wrapped, currencyB?.wrapped, baseCurrency?.wrapped],
    [currencyA, currencyB, baseCurrency]
  )

  const [token0, token1] = useMemo(
    () =>
      tokenA && tokenB ? (tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]) : [undefined, undefined],
    [tokenA, tokenB]
  )

  // balances
  const balances = useCurrencyBalances(
    account ?? undefined,
    useMemo(() => [currencies[Field.CURRENCY_A], currencies[Field.CURRENCY_B]], [currencies])
  )
  const currencyBalances: { [field in Field]?: CurrencyAmount<Currency> } = {
    [Field.CURRENCY_A]: balances[0],
    [Field.CURRENCY_B]: balances[1],
  }

  // pool
  const [poolState, pool] = usePool(currencies[Field.CURRENCY_A], currencies[Field.CURRENCY_B], feeAmount)
  const noLiquidity = poolState === PoolState.NOT_EXISTS

  // note to parse inputs in reverse
  const invertPrice = Boolean(baseToken && token0 && !baseToken.equals(token0))

  // always returns the price with 0 as base token
  const price: Price<Token, Token> | undefined = useMemo(() => {
    // if no liquidity use typed value
    if (noLiquidity) {
      const parsedQuoteAmount = tryParseCurrencyAmount(startPriceTypedValue, invertPrice ? token0 : token1)
      if (parsedQuoteAmount && token0 && token1) {
        const baseAmount = tryParseCurrencyAmount('1', invertPrice ? token1 : token0)
        const price =
          baseAmount && parsedQuoteAmount
            ? new Price(
                baseAmount.currency,
                parsedQuoteAmount.currency,
                baseAmount.quotient,
                parsedQuoteAmount.quotient
              )
            : undefined
        return (invertPrice ? price?.invert() : price) ?? undefined
      }
      return undefined
    } else {
      // get the amount of quote currency
      return pool ? reverseMapPrice<Token, Token>(pool.token0Price) : undefined
    }
  }, [noLiquidity, startPriceTypedValue, invertPrice, token1, token0, pool])

  // check for invalid price input (converts to invalid ratio)
  // used for ratio calculation when pool not initialized

  const [mockPoolData, setMockPoolData] = useState<{
    invalidPrice?: boolean | ''
    mockPool?: Pool
  }>({})
  const cancelableMockPool = useRef<CancelablePromise<{ invalidPrice?: boolean | ''; mockPool?: Pool } | undefined>>()

  useEffect(() => {
    cancelableMockPool.current?.cancel()
    const mockPoolPromise = loadMockPool(price, feeAmount, tokenA, tokenB, client)
    cancelableMockPool.current = makeCancelable(mockPoolPromise)
    cancelableMockPool.current?.promise.then((res) => {
      if (!res) return
      setMockPoolData(res)
    })
    return () => cancelableMockPool.current?.cancel()
  }, [price, feeAmount, tokenA, tokenB, client])

  const { invalidPrice, mockPool } = mockPoolData

  // if pool exists use it, if not use the mock pool
  const poolForPosition: Pool | undefined = pool ?? mockPool

  // lower and upper limits in the tick space for `feeAmoun<Trans>
  const [tickSpaceLimits, setTickSpaceLimits] = useState<{ LOWER?: number; UPPER?: number }>({})
  const cancelableTickLimits = useRef<CancelablePromise<{ LOWER?: number; UPPER?: number } | undefined>>()

  useEffect(() => {
    cancelableTickLimits.current?.cancel()
    if (feeAmount === undefined) {
      setTickSpaceLimits({})
    } else {
      const tickLimitsPromise = loadTickSpaceLimits(client, feeAmount)
      cancelableTickLimits.current = makeCancelable(tickLimitsPromise)
      cancelableTickLimits.current?.promise.then((res) => {
        if (!res) return
        setTickSpaceLimits(res)
      })
    }
    return () => cancelableTickLimits.current?.cancel()
  }, [feeAmount, client])

  // parse typed range values and determine closest ticks
  // lower should always be a smaller tick
  const [ticks, setTicks] = useState<{ LOWER?: number; UPPER?: number }>({})
  const cancelableTicks = useRef<CancelablePromise<{ LOWER?: number; UPPER?: number } | undefined>>()

  useEffect(() => {
    cancelableTicks.current?.cancel()
    const ticksPromise = loadTicks(
      existingPosition,
      feeAmount,
      invertPrice,
      leftRangeTypedValue,
      rightRangeTypedValue,
      token0,
      token1,
      tickSpaceLimits,
      client
    )
    cancelableTicks.current = makeCancelable(ticksPromise)
    cancelableTicks.current?.promise.then((res) => {
      if (!res) return
      setTicks(res)
    })
    return () => cancelableTicks.current?.cancel()
  }, [
    existingPosition,
    feeAmount,
    invertPrice,
    leftRangeTypedValue,
    rightRangeTypedValue,
    token0,
    token1,
    tickSpaceLimits,
    client,
  ])
  const { [Bound.LOWER]: tickLower, [Bound.UPPER]: tickUpper } = ticks || {}

  // specifies whether the lower and upper ticks is at the exteme bounds
  const ticksAtLimit = useMemo(
    () => ({
      [Bound.LOWER]: feeAmount !== undefined && tickLower === tickSpaceLimits.LOWER,
      [Bound.UPPER]: feeAmount !== undefined && tickUpper === tickSpaceLimits.UPPER,
    }),
    [tickSpaceLimits, tickLower, tickUpper, feeAmount]
  )

  // mark invalid range
  const invalidRange = Boolean(typeof tickLower === 'number' && typeof tickUpper === 'number' && tickLower >= tickUpper)

  // always returns the price with 0 as base token
  const [pricesAtTicks, setPricesAtTicks] = useState<{ LOWER?: Price<Token, Token>; UPPER?: Price<Token, Token> }>({})
  const cancelablePrices = useRef<CancelablePromise<(Price<Token, Token> | undefined)[] | undefined>>()
  useEffect(() => {
    cancelablePrices.current?.cancel()
    const pricePromise = Promise.all([
      getTickToPrice(client, token0, token1, ticks[Bound.LOWER]),
      getTickToPrice(client, token0, token1, ticks[Bound.UPPER]),
    ])
    cancelablePrices.current = makeCancelable(pricePromise)
    cancelablePrices.current?.promise.then((prices) => {
      if (!prices) return
      setPricesAtTicks({
        [Bound.LOWER]: prices[0],
        [Bound.UPPER]: prices[1],
      })
    })
    return () => cancelablePrices.current?.cancel()
  }, [token0, token1, ticks, client])

  const { [Bound.LOWER]: lowerPrice, [Bound.UPPER]: upperPrice } = pricesAtTicks

  // liquidity range warning
  const outOfRange = Boolean(
    !invalidRange && price && lowerPrice && upperPrice && (price.lessThan(lowerPrice) || price.greaterThan(upperPrice))
  )

  // amounts
  const independentAmount: CurrencyAmount<Currency> | undefined = tryParseCurrencyAmount(
    typedValue,
    currencies[independentField]
  )

  const [dependentAmount, setDependentAmount] = useState<CurrencyAmount<Currency> | undefined>(undefined)
  const cancelablePositionOne = useRef<CancelablePromise<InvokeResult<Position> | undefined>>()

  useEffect(() => {
    cancelablePositionOne.current?.cancel()
    // we wrap the currencies just to get the price in terms of the other token
    // if price is out of range or invalid range - return 0 (single deposit will be independent)
    const wrappedIndependentAmount = independentAmount?.wrapped
    if (
      !(
        independentAmount &&
        wrappedIndependentAmount &&
        typeof tickLower === 'number' &&
        typeof tickUpper === 'number' &&
        poolForPosition
      ) ||
      outOfRange ||
      invalidRange
    ) {
      setDependentAmount(undefined)
    } else {
      const indEqualsToken0 = tokenEquals(mapToken(wrappedIndependentAmount.currency), poolForPosition.token0)
      const positionPromise = indEqualsToken0
        ? Uni_Module.createPositionFromAmount0(
            {
              pool: poolForPosition,
              tickLower,
              tickUpper,
              amount0: independentAmount.quotient.toString(),
              useFullPrecision: true, // we want full precision for the theoretical position
            },
            client
          )
        : Uni_Module.createPositionFromAmount1(
            {
              pool: poolForPosition,
              tickLower,
              tickUpper,
              amount1: independentAmount.quotient.toString(),
            },
            client
          )
      cancelablePositionOne.current = makeCancelable(positionPromise)
      cancelablePositionOne.current?.promise.then((res) => {
        if (!res) return
        if (res.error) {
          console.error(res.error)
          setDependentAmount(undefined)
          return
        }
        const position: Position = res.data as Position
        const dependentTokenAmount = indEqualsToken0 ? position.token1Amount : position.token0Amount
        const dependentCurrency = dependentField === Field.CURRENCY_B ? currencyB : currencyA
        const amount = dependentCurrency && CurrencyAmount.fromRawAmount(dependentCurrency, dependentTokenAmount.amount)
        setDependentAmount(amount)
      })
    }
    return () => cancelablePositionOne.current?.cancel()
  }, [
    independentAmount,
    outOfRange,
    dependentField,
    currencyB,
    currencyA,
    tickLower,
    tickUpper,
    poolForPosition,
    invalidRange,
    client,
  ])

  const parsedAmounts: { [field in Field]: CurrencyAmount<Currency> | undefined } = useMemo(() => {
    return {
      [Field.CURRENCY_A]: independentField === Field.CURRENCY_A ? independentAmount : dependentAmount,
      [Field.CURRENCY_B]: independentField === Field.CURRENCY_A ? dependentAmount : independentAmount,
    }
  }, [dependentAmount, independentAmount, independentField])

  // single deposit only if price is out of range
  const deposit0Disabled = Boolean(
    typeof tickUpper === 'number' && poolForPosition && poolForPosition.tickCurrent >= tickUpper
  )
  const deposit1Disabled = Boolean(
    typeof tickLower === 'number' && poolForPosition && poolForPosition.tickCurrent <= tickLower
  )

  // sorted for token order
  const depositADisabled =
    invalidRange ||
    Boolean(
      (deposit0Disabled && poolForPosition && tokenA && tokenEquals(poolForPosition.token0, mapToken(tokenA))) ||
        (deposit1Disabled && poolForPosition && tokenA && tokenEquals(poolForPosition.token1, mapToken(tokenA)))
    )
  const depositBDisabled =
    invalidRange ||
    Boolean(
      (deposit0Disabled && poolForPosition && tokenB && tokenEquals(poolForPosition.token0, mapToken(tokenB))) ||
        (deposit1Disabled && poolForPosition && tokenB && tokenEquals(poolForPosition.token1, mapToken(tokenB)))
    )

  // create position entity based on users selection
  const [position, setPosition] = useState<Position | undefined>(undefined)
  const cancelablePositionTwo = useRef<CancelablePromise<InvokeResult<Position> | undefined>>()

  useEffect(() => {
    cancelablePositionTwo.current?.cancel()
    if (
      !poolForPosition ||
      !tokenA ||
      !tokenB ||
      typeof tickLower !== 'number' ||
      typeof tickUpper !== 'number' ||
      invalidRange
    ) {
      setPosition(undefined)
      return
    }

    // mark as 0 if disabled because out of range
    const amount0 = !deposit0Disabled
      ? parsedAmounts?.[
          tokenA.equals(reverseMapToken(poolForPosition.token0) as Token) ? Field.CURRENCY_A : Field.CURRENCY_B
        ]?.quotient
      : BIG_INT_ZERO
    const amount1 = !deposit1Disabled
      ? parsedAmounts?.[
          tokenA.equals(reverseMapToken(poolForPosition.token0) as Token) ? Field.CURRENCY_B : Field.CURRENCY_A
        ]?.quotient
      : BIG_INT_ZERO

    if (amount0 === undefined || amount1 === undefined) {
      setPosition(undefined)
      return
    }

    const positionPromise = Uni_Module.createPositionFromAmounts(
      {
        pool: poolForPosition,
        tickLower,
        tickUpper,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        useFullPrecision: true, // we want full precision for the theoretical position
      },
      client
    )
    cancelablePositionTwo.current = makeCancelable(positionPromise)
    cancelablePositionTwo.current?.promise.then((res) => {
      if (!res) return
      if (res.error) {
        console.error(res.error)
        setPosition(undefined)
        return
      }
      setPosition(res.data)
    })
    return () => cancelablePositionTwo.current?.cancel()
  }, [
    parsedAmounts,
    poolForPosition,
    tokenA,
    tokenB,
    deposit0Disabled,
    deposit1Disabled,
    invalidRange,
    tickLower,
    tickUpper,
    client,
  ])

  let errorMessage: ReactNode | undefined
  if (!account) {
    errorMessage = <Trans>Connect Wallet</Trans>
  }

  if (poolState === PoolState.INVALID) {
    errorMessage = errorMessage ?? <Trans>Invalid pair</Trans>
  }

  if (invalidPrice) {
    errorMessage = errorMessage ?? <Trans>Invalid price input</Trans>
  }

  if (
    (!parsedAmounts[Field.CURRENCY_A] && !depositADisabled) ||
    (!parsedAmounts[Field.CURRENCY_B] && !depositBDisabled)
  ) {
    errorMessage = errorMessage ?? <Trans>Enter an amount</Trans>
  }

  const { [Field.CURRENCY_A]: currencyAAmount, [Field.CURRENCY_B]: currencyBAmount } = parsedAmounts

  if (currencyAAmount && currencyBalances?.[Field.CURRENCY_A]?.lessThan(currencyAAmount)) {
    errorMessage = <Trans>Insufficient {currencies[Field.CURRENCY_A]?.symbol} balance</Trans>
  }

  if (currencyBAmount && currencyBalances?.[Field.CURRENCY_B]?.lessThan(currencyBAmount)) {
    errorMessage = <Trans>Insufficient {currencies[Field.CURRENCY_B]?.symbol} balance</Trans>
  }

  const invalidPool = poolState === PoolState.INVALID

  return {
    dependentField,
    currencies,
    pool,
    poolState,
    currencyBalances,
    parsedAmounts,
    ticks,
    price,
    pricesAtTicks,
    position,
    noLiquidity,
    errorMessage,
    invalidPool,
    invalidRange,
    outOfRange,
    depositADisabled,
    depositBDisabled,
    invertPrice,
    ticksAtLimit,
  }
}

export function useRangeHopCallbacks(
  baseCurrency: Currency | undefined,
  quoteCurrency: Currency | undefined,
  feeAmount: FeeAmountEnum | undefined,
  tickLower: number | undefined,
  tickUpper: number | undefined,
  pool?: Pool | undefined | null
) {
  const dispatch = useAppDispatch()
  const client: PolywrapClient = usePolywrapClient()

  const baseToken = useMemo(() => baseCurrency?.wrapped, [baseCurrency])
  const quoteToken = useMemo(() => quoteCurrency?.wrapped, [quoteCurrency])

  const getDecrementLower = useCallback(async () => {
    if (baseToken && quoteToken && typeof tickLower === 'number' && feeAmount !== undefined) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: tickLower - tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    // use pool current tick as starting tick if we have pool but no tick input
    if (!(typeof tickLower === 'number') && baseToken && quoteToken && feeAmount !== undefined && pool) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: pool.tickCurrent - tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    return ''
  }, [baseToken, quoteToken, tickLower, feeAmount, pool, client])

  const getIncrementLower = useCallback(async () => {
    if (baseToken && quoteToken && typeof tickLower === 'number' && feeAmount !== undefined) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: tickLower + tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    // use pool current tick as starting tick if we have pool but no tick input
    if (!(typeof tickLower === 'number') && baseToken && quoteToken && feeAmount !== undefined && pool) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: pool.tickCurrent + tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    return ''
  }, [baseToken, quoteToken, tickLower, feeAmount, pool, client])

  const getDecrementUpper = useCallback(async () => {
    if (baseToken && quoteToken && typeof tickUpper === 'number' && feeAmount !== undefined) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: tickUpper - tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    // use pool current tick as starting tick if we have pool but no tick input
    if (!(typeof tickUpper === 'number') && baseToken && quoteToken && feeAmount !== undefined && pool) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: pool.tickCurrent - tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    return ''
  }, [baseToken, quoteToken, tickUpper, feeAmount, pool, client])

  const getIncrementUpper = useCallback(async () => {
    if (baseToken && quoteToken && typeof tickUpper === 'number' && feeAmount !== undefined) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: tickUpper + tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    // use pool current tick as starting tick if we have pool but no tick input
    if (!(typeof tickUpper === 'number') && baseToken && quoteToken && feeAmount !== undefined && pool) {
      const tickSpacingInvoke = await Uni_Module.feeAmountToTickSpacing({ feeAmount }, client)
      if (tickSpacingInvoke.error) {
        console.error(tickSpacingInvoke.error)
        return ''
      }
      const tickSpacing = tickSpacingInvoke.data as number

      const newPriceInvoke = await Uni_Module.tickToPrice(
        {
          baseToken: mapToken(baseToken),
          quoteToken: mapToken(quoteToken),
          tick: pool.tickCurrent + tickSpacing,
        },
        client
      )
      if (newPriceInvoke.error) {
        console.error(newPriceInvoke.error)
        return ''
      }
      const newPrice = newPriceInvoke.data as Uni_Price

      return reverseMapPrice(newPrice).toSignificant(5, undefined, Rounding.ROUND_UP)
    }
    return ''
  }, [baseToken, quoteToken, tickUpper, feeAmount, pool, client])

  const getSetFullRange = useCallback(() => {
    dispatch(setFullRange())
  }, [dispatch])

  return { getDecrementLower, getIncrementLower, getDecrementUpper, getIncrementUpper, getSetFullRange }
}
