import ganache from 'ganache-core'
import Web3 from 'web3'

export default (gasLimit = 50000000) => async (t) => {
  // Set up provider w/ monkey patch needed for Web3 1.0.0
  let provider = ganache.provider({
    gasLimit
  })
  provider = Object.assign(
    provider,
    { send: provider.sendAsync.bind(provider) })

  const web3 = new Web3(provider)

  t.context.provider = provider
  t.context.web3 = web3
  t.context.accounts = await web3.eth.getAccounts()
}
