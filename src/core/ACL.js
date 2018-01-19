// @flow
// $FlowFixMe
import callscript from '../utils/callscript'

export type EthereumTransaction = {
  from: string,
  to: string,
  data: string,
  value?: number,
  gas?: number,
  gasPrice?: number
}

export type DescribedEthereumTransaction = {
  description: string
} & EthereumTransaction

export default class ACL {
  // $FlowFixMe
  constructor (kernelProxy, wrapper) {
    // $FlowFixMe
    this.web3 = wrapper.web3
    // $FlowFixMe
    this.proxy = kernelProxy

    // $FlowFixMe
    this._state = this.proxy.events()
      .filter(
        ({ event }) => event === 'SetPermission'
      )
      .scan(
        (state, { returnValues: values }) => {
          if (!state[values.app]) state[values.app] = {}
          const currentPermissions = state[values.app][values.role] || []

          if (values.allowed) {
            state[values.app][values.role] = currentPermissions.concat([values.entity])
          } else {
            state[values.app][values.role] = currentPermissions
              .filter((entity) => entity !== values.entity)
          }

          return state
        }, {}
      )
  }

  /**
   * Get the state of the ACL.
   *
   * @return {Observable} An observable of ACL states.
   */
  state () {
    // $FlowFixMe
    return this._state
  }

  /**
   * Checks if the given address is a forwarder.
   *
   * @param {string} forwarderAddress The address of the suspected forwarder
   * @return {Promise<boolean>}
   */
  isForwarder (forwarderAddress: string): Promise<boolean> {
    // $FlowFixMe
    const forwarder = new this.web3.eth.Contract(
      require('../../abi/aragon/Forwarder.json'),
      forwarderAddress
    )

    return forwarder.methods.isForwarder().call()
      .catch(() => false)
  }

  /**
   * Get a list of forwarders over time.
   *
   * @return {Observable} An observable array of forwarder addresses
   */
  forwarders () {
    return this.proxy.events()
      .filter(
        ({ event }) => event === 'SetPermission'
      )
      .mergeMap(
        async ({ returnValues: values }) => ({
          app: values.app,
          isForwarder: await this.isForwarder(values.app)
        })
      )
      .filter(
        ({ isForwarder }) => isForwarder
      )
      .scan(
        (state, { app }) => state.concat(app),
        []
      )
  }

  /**
   * Check if the given forwarder at `forwarderAddress` can forward a transaction
   * encoded in `script` for entity `senderAddress`.
   *
   * @param {string} forwarderAddress The address of the forwarder
   * @param {string} senderAddress The address of the sender
   * @param {string} script The EVM callscript to forward
   * @return {Promise<boolean>}
   */
  async canForward (
    forwarderAddress: string,
    senderAddress: string,
    script: string
  ): Promise<boolean> {
    // $FlowFixMe
    const forwarder = new this.web3.eth.Contract(
      require('../../abi/aragon/Forwarder.json'),
      forwarderAddress
    )

    return forwarder.methods.canForward(senderAddress, script).call()
  }

  /**
   * Get a path of transactions that makes it possible to execute a method
   * with the name `method` on `address`.
   */
  async getTransactionPath (
    address: string,
    methodName: string,
    params: Array<any>
  ): Promise<Array<EthereumTransaction>> {
    // Take a snapshot of the current ACL state
    const acl = await this.state().take(1).toPromise()

    // Take a snapshot of the current list of forwarders
    let allForwarders = await this.forwarders().take(1).toPromise()

    // Get the user address from the wrapper
    // $FlowFixMe
    const sender = this.wrapper.getUserAddress()

    // Get the ACL sig for `method` and the ABI for `address`
    // $FlowFixMe
    const appsSnapshot = await this.wrapper.apps().take(1).toPromise()
    const appArtifact = appsSnapshot[address]
    if (!appArtifact) {
      throw new Error(`No artifact found for ${address}`)
    }

    const abi = appArtifact.abi
    if (!abi) {
      throw new Error(`No ABI specified in artifact for ${address}`)
    }

    // $FlowFixMe
    const contract = new this.web3.eth.Contract(abi)

    const functions = appArtifact.functions
    if (!functions) {
      throw new Error(`No functions specified in artifact for ${address}`)
    }

    const method = appArtifact.functions[methodName]
    if (!method) {
      throw new Error(`No method named ${methodName} specified in artifact for ${address}`)
    }

    const role = appArtifact.roles[method.roleNeeded]
    if (!role) {
      throw new Error(`Invalid role specified for ${methodName} in artifact for ${address}`)
    }

    const sig = role.bytes

    // Create the "direct" transaction
    const directTransaction: EthereumTransaction = {
      from: sender,
      to: address,
      data: contract.methods[method](...params).encodeABI()
    }

    // There is no entries in the ACL for `address`
    if (!acl.hasOwnProperty(address)) {
      return []
    }

    // There is no entries for `sig` on `address`
    if (!acl[address][sig]) {
      return []
    }

    // Check if we have direct access to perform an action with `sig` on `address`
    if (acl[address][sig][sender]) {
      return [directTransaction]
    }

    // Find forwarders with permission to perform an action with `sig` on `address`
    const forwardersWithPermission = acl[address][sig]
      .filter(
        (entity) => allForwarders.includes(entity)
      )

    // No forwarders can perform the requested action
    if (forwardersWithPermission.length === 0) {
      return []
    }

    // A helper method to create a transaction that calls `forward` on a forwarder
    // with `script`
    // $FlowFixMe
    const forwardMethod = new this.web3.eth.Contract(
      require('../../abi/aragon/Forwarder.json')
    ).methods['forward']
    const createForwarderTransaction = (forwarderAddress, script) => ({
      from: sender,
      to: forwarderAddress,
      data: forwardMethod(script).encodeABI()
    })

    // Check if one of the forwarders that has permission to perform an action
    // with `sig` on `address` can forward for us directly
    for (const forwarder of forwardersWithPermission) {
      let script = callscript.encode(directTransaction)
      if (await this.canForward(forwarder, sender, script)) {
        return [createForwarderTransaction(forwarder, script), directTransaction]
      }
    }

    // Get a list of all forwarders (excluding the forwarders with direct permission)
    allForwarders = allForwarders
      .filter(
        (forwarder) => !forwardersWithPermission.includes(forwarder)
      )

    // Set up the path finding queue
    // The queue takes the form of Array<[Array<EthereumTransaction>, Array<String>]>
    // In other words: it is an array of tuples, where the first index of the tuple
    // is the current path and the second index of the tuple is the
    // queue (a list of unexplored forwarder addresses) for that path
    type TransactionPathQueueItem = [Array<EthereumTransaction>, Array<string>]
    type TransactionPathQueue = Array<TransactionPathQueueItem>
    const queue: TransactionPathQueue = forwardersWithPermission.map(
      (forwarderWithPermission) => [
        [createForwarderTransaction(
          forwarderWithPermission, callscript.encode(directTransaction)
        ), directTransaction], allForwarders
      ]
    )

    // Find the shortest path
    // TODO(onbjerg): Should we find and return multiple paths?
    do {
      const [path, [forwarder, ...nextQueue]] = queue.shift()

      // Skip paths longer than 10
      if (path.length > 10) continue

      // Get the previous forwarder address
      const previousForwarder = path[0].to

      // Encode the previous transaction into an EVM callscript
      let script = callscript.encode(path[0])

      if (await this.canForward(previousForwarder, forwarder, script)) {
        if (await this.canForward(forwarder, sender, script)) {
          // The previous forwarder can forward a transaction for this forwarder,
          // and this forwarder can forward for our user, so we have found a path
          return [createForwarderTransaction(forwarder, script), ...path]
        } else {
          // The previous forwarder can forward a transaction for this forwarder,
          // but this forwarder can not forward for our user, so we add it as a
          // possible path in the queue for later exploration.
          // TODO(onbjerg): Should `allForwarders` be filtered to exclude forwarders in the path already?
          queue.push([[createForwarderTransaction(forwarder, script), ...path], allForwarders])
        }
      }

      // We add the current path on the back of the queue again, but we shorten
      // the list of possible forwarders.
      queue.push([path, nextQueue])
    } while (queue.length)

    // No path was found
    return []
  }
}
