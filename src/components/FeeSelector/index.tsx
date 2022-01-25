import { Trans } from '@lingui/macro'
import { Currency } from '@uniswap/sdk-core'
import { ButtonGray } from 'components/Button'
import Card from 'components/Card'
import { AutoColumn } from 'components/Column'
import { RowBetween } from 'components/Row'
import { useFeeTierDistribution } from 'hooks/useFeeTierDistribution'
import { PoolState, usePools } from 'hooks/usePools'
import usePrevious from 'hooks/usePrevious'
import { useActiveWeb3React } from 'hooks/web3'
import { DynamicSection } from 'pages/AddLiquidity/styled'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactGA from 'react-ga'
import { Box } from 'rebass'
import styled, { keyframes } from 'styled-components/macro'
import { ThemedText } from 'theme'

import { FeeAmountEnum } from '../../polywrap'
import { FeeOption } from './FeeOption'
import { FeeTierPercentageBadge } from './FeeTierPercentageBadge'
import { FEE_AMOUNT_DETAIL } from './shared'

const pulse = (color: string) => keyframes`
  0% {
    box-shadow: 0 0 0 0 ${color};
  }

  70% {
    box-shadow: 0 0 0 2px ${color};
  }

  100% {
    box-shadow: 0 0 0 0 ${color};
  }
`
const FocusedOutlineCard = styled(Card)<{ pulsing: boolean }>`
  border: 1px solid ${({ theme }) => theme.bg2};
  animation: ${({ pulsing, theme }) => pulsing && pulse(theme.primary1)} 0.6s linear;
  align-self: center;
`

const Select = styled.div`
  align-items: flex-start;
  display: grid;
  grid-auto-flow: column;
  grid-gap: 8px;
`

export default function FeeSelector({
  disabled = false,
  feeAmount,
  handleFeePoolSelect,
  currencyA,
  currencyB,
}: {
  disabled?: boolean
  feeAmount?: FeeAmountEnum
  handleFeePoolSelect: (feeAmount: FeeAmountEnum) => void
  currencyA?: Currency | undefined
  currencyB?: Currency | undefined
}) {
  const { chainId } = useActiveWeb3React()

  const { isLoading, isError, largestUsageFeeTier, distributions } = useFeeTierDistribution(currencyA, currencyB)

  // get pool data on-chain for latest states
  const pools = usePools([
    [currencyA, currencyB, FeeAmountEnum.LOWEST],
    [currencyA, currencyB, FeeAmountEnum.LOW],
    [currencyA, currencyB, FeeAmountEnum.MEDIUM],
    [currencyA, currencyB, FeeAmountEnum.HIGH],
  ])

  const poolsByFeeTier: Record<FeeAmountEnum, PoolState> = useMemo(
    () =>
      pools.reduce(
        (acc, [curPoolState, curPool]) => {
          if (curPool) {
            acc = {
              ...acc,
              ...{ [curPool.fee]: curPoolState },
            }
          }
          return acc
        },
        {
          // default all states to NOT_EXISTS
          [FeeAmountEnum.LOWEST]: PoolState.NOT_EXISTS,
          [FeeAmountEnum.LOW]: PoolState.NOT_EXISTS,
          [FeeAmountEnum.MEDIUM]: PoolState.NOT_EXISTS,
          [FeeAmountEnum.HIGH]: PoolState.NOT_EXISTS,
        }
      ),
    [pools]
  )

  const [showOptions, setShowOptions] = useState(false)
  const [pulsing, setPulsing] = useState(false)

  const previousFeeAmount = usePrevious(feeAmount)

  const recommended = useRef(false)

  const handleFeePoolSelectWithEvent = useCallback(
    (fee: FeeAmountEnum) => {
      ReactGA.event({
        category: 'FeePoolSelect',
        action: 'Manual',
      })
      handleFeePoolSelect(fee)
    },
    [handleFeePoolSelect]
  )

  useEffect(() => {
    if (feeAmount !== undefined || isLoading || isError) {
      return
    }

    if (!largestUsageFeeTier) {
      // cannot recommend, open options
      setShowOptions(true)
    } else {
      setShowOptions(false)

      recommended.current = true
      ReactGA.event({
        category: 'FeePoolSelect',
        action: ' Recommended',
      })

      handleFeePoolSelect(largestUsageFeeTier)
    }
  }, [feeAmount, isLoading, isError, largestUsageFeeTier, handleFeePoolSelect])

  useEffect(() => {
    setShowOptions(isError)
  }, [isError])

  useEffect(() => {
    if (feeAmount !== undefined && previousFeeAmount !== feeAmount) {
      setPulsing(true)
    }
  }, [previousFeeAmount, feeAmount])

  return (
    <AutoColumn gap="16px">
      <DynamicSection gap="md" disabled={disabled}>
        <FocusedOutlineCard pulsing={pulsing} onAnimationEnd={() => setPulsing(false)}>
          <RowBetween>
            <AutoColumn id="add-liquidity-selected-fee">
              {feeAmount === undefined ? (
                <>
                  <ThemedText.Label>
                    <Trans>Fee tier</Trans>
                  </ThemedText.Label>
                  <ThemedText.Main fontWeight={400} fontSize="12px" textAlign="left">
                    <Trans>The % you will earn in fees.</Trans>
                  </ThemedText.Main>
                </>
              ) : (
                <>
                  <ThemedText.Label className="selected-fee-label">
                    <Trans>{FEE_AMOUNT_DETAIL[feeAmount].label}% fee tier</Trans>
                  </ThemedText.Label>
                  <Box style={{ width: 'fit-content', marginTop: '8px' }} className="selected-fee-percentage">
                    {distributions && (
                      <FeeTierPercentageBadge
                        distributions={distributions}
                        feeAmount={feeAmount}
                        poolState={poolsByFeeTier[feeAmount]}
                      />
                    )}
                  </Box>
                </>
              )}
            </AutoColumn>

            <ButtonGray onClick={() => setShowOptions(!showOptions)} width="auto" padding="4px" $borderRadius="6px">
              {showOptions ? <Trans>Hide</Trans> : <Trans>Edit</Trans>}
            </ButtonGray>
          </RowBetween>
        </FocusedOutlineCard>

        {chainId && showOptions && (
          <Select>
            {[FeeAmountEnum.LOWEST, FeeAmountEnum.LOW, FeeAmountEnum.MEDIUM, FeeAmountEnum.HIGH].map(
              (_feeAmount, i) => {
                const { supportedChains } = FEE_AMOUNT_DETAIL[_feeAmount]
                if (supportedChains.includes(chainId)) {
                  return (
                    <FeeOption
                      feeAmount={_feeAmount}
                      active={feeAmount === _feeAmount}
                      onClick={() => handleFeePoolSelectWithEvent(_feeAmount)}
                      distributions={distributions}
                      poolState={poolsByFeeTier[_feeAmount]}
                      key={i}
                    />
                  )
                }
                return null
              }
            )}
          </Select>
        )}
      </DynamicSection>
    </AutoColumn>
  )
}
