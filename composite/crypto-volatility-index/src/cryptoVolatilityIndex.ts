import { util } from '@chainlink/ea-bootstrap'
import { logger } from '@chainlink/external-adapter'
import { getRpcLatestRound } from '@chainlink/reference-data-reader'
import { getDerivativesData, CurrencyDerivativesData } from './derivativesDataProvider'
import { getDominanceAdapter, dominanceByCurrency } from './dominance-data-providers'
import { SigmaCalculator } from './sigmaCalculator'
import { Big } from 'big.js'
import moment from 'moment'
const cryptoCurrencies = ['BTC', 'ETH']

export const calculate = async (
  oracleAddress: string,
  multiply: number,
  heartbeatMinutes: number,
): Promise<number> => {
  // Get all of the required derivatives data for the calculations, for all the relevant currencies
  const derivativesData = await getDerivativesData(cryptoCurrencies)
  // Calculate vix values for all currencies
  const volatilityIndexData = await calculateVixValues(derivativesData)
  // Apply weights to calculate the Crypto Vix
  const weightedCVI = await calculateWeighted(volatilityIndexData)
  // Smooth CVI with previous on-chain value if exists
  const cvi = await applySmoothing(weightedCVI, oracleAddress, multiply, heartbeatMinutes)

  logger.info(`CVI: ${cvi}`)
  validateIndex(cvi, multiply)
  return cvi
}

const calculateVixValues = async (derivativesData: Record<string, CurrencyDerivativesData>) => {
  const now = moment().utc()
  const sigmaCalculator = new SigmaCalculator()
  const vixValues = cryptoCurrencies.map((currency) => {
    sigmaCalculator.sortByStrikePrice(derivativesData[currency])
    const { e1, e2, exchangeRate, callsE1, putsE1, callsE2, putsE2 } = derivativesData[currency]
    const weightedSigma: Big = sigmaCalculator.weightedSigma({
      e1,
      e2,
      sigma1: sigmaCalculator.oneSigma(e1, exchangeRate, callsE1, putsE1, now),
      sigma2: sigmaCalculator.oneSigma(e2, exchangeRate, callsE2, putsE2, now),
      now,
    })
    return weightedSigma.sqrt().times(100)
  })

  return vixValues
}

const calculateWeighted = async (vixData: Array<Big>) => {
  const dominanceByCurrency = await getDominanceByCurrency()
  const weightedVix = cryptoCurrencies.reduce((vix, currency, idx) => {
    const dominance = dominanceByCurrency[currency]
    if (!dominance) throw new Error(`No dominance found for currency ${currency}`)
    const currencyVix = new Big(vixData[idx])
    // Weight by dominance
    vix = vix.plus(currencyVix.times(new Big(dominance)))
    return vix
  }, new Big(0))

  const weighted = Number(weightedVix.toFixed())
  logger.debug(`Weighted volatility index:${weighted}`)
  return weighted
}

const getDominanceByCurrency = async () => {
  const dominanceProvider = util.getRequiredEnv('DOMINANCE_PROVIDER')
  const dominanceAdapter = await getDominanceAdapter(dominanceProvider)
  const dominanceData = await dominanceAdapter.getDominance(cryptoCurrencies)
  return dominanceByCurrency(dominanceData)
}

const applySmoothing = async (
  weightedCVI: number,
  oracleAddress: string,
  multiply: number,
  heartBeatMinutes: number,
): Promise<number> => {
  const roundData = await getRpcLatestRound(oracleAddress, multiply)
  const latestIndex = new Big(roundData.answer.toString())
  const updatedAt = roundData.updatedAt.mul(1000).toNumber()
  const cvi = toOnChainValue(weightedCVI, multiply)

  if (latestIndex.lte(0)) {
    logger.warn('No on-chain index value found - Is first run of adapter?')
    return cvi
  }

  const now = moment().utc()
  const dtSeconds = moment.duration(now.diff(updatedAt)).asSeconds()
  if (dtSeconds < 0) {
    throw new Error('invalid time, please check the node clock')
  }
  const l = lambda(dtSeconds, heartBeatMinutes)
  const smoothed = latestIndex.mul(new Big(1 - l)).add(new Big(cvi).mul(l))
  logger.debug(`Previous value:${latestIndex}, updatedAt:${updatedAt}, dtSeconds:${dtSeconds}`)
  return smoothed.round().toNumber()
}

const LAMBDA_MIN = 0.01
const LAMBDA_K = 0.1
const lambda = function (t: number, heartBeatMinutes: number) {
  const T = moment.duration(heartBeatMinutes, 'minutes').asSeconds()
  return LAMBDA_MIN + (LAMBDA_K * Math.min(t, T)) / T
}

const MAX_INDEX = 200
const validateIndex = function (cvi: number, multiply: number) {
  if (cvi <= 0 || cvi > MAX_INDEX * multiply) {
    throw new Error('Invalid calculated index value')
  }
}

const toOnChainValue = function (cvi: number, multiply: number) {
  const trimmed = Number(cvi.toFixed(multiply.toString().length - 1)) // Keep decimal precision in same magnitude as multiply
  return trimmed * multiply
}
