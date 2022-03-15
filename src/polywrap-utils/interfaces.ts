import { CurrencyAmount, Token } from '@uniswap/sdk-core'

import { Uni_Trade } from '../polywrap'

export interface ExtendedTrade extends Uni_Trade {
  gasUseEstimateUSD?: CurrencyAmount<Token> | null
}
