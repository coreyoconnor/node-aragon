import namehash from 'eth-ens-namehash'
import { keccak256 } from 'js-sha3'

function getTestFixture (fixture) {
  return require(`../fixtures/${fixture}`)
}

/**
 * Get a contract artifact and decorate it with init parameters,
 * a unique identifier and the sender.
 *
 * @param  {string} artifactName The name of the artifact
 * @param  {string} id           A unique identifier for the artifact
 * @param  {string} from         The default sender
 * @param  {Array=[]}  init      Initialisation parameters
 * @return {Object}
 */
function getContractArtifact (artifactName, id, from, init = []) {
  return Object.assign(
    getTestFixture(`artifacts/${artifactName}.json`), {
    id,
    init,
    from
  })
}

/**
 * Deploys a set of Truffle artifacts to a local development chain.
 *
 * @param  {Array<object>} artifacts
 * @param  {Number} gas The gas limit to deploy with
 */
export function deploy (artifacts, gas = 50000000) {
  return async function (t) {
    // Set up Web3
    const web3 = t.context.web3

    // Deploy contracts
    const from = await web3.eth.getCoinbase()
    const addresses = await Promise.all(
      artifacts.map(({ abi, from, bytecode }) =>
        new web3.eth.Contract(abi, {
          from,
          data: bytecode,
          gas
        })
      ).map((contract, index) =>
        contract.deploy({
          arguments: artifacts[index].init || []
        }).send()
      )
    ).then((deployments) => {
      // Set context
      t.context.contracts = deployments.reduce((contracts, deployment, index) =>
        Object.assign(contracts, { [artifacts[index].id]: deployment }),
        t.context.contracts || {}
      )
      t.context.addresses = deployments.reduce((addresses, deployment, index) =>
        Object.assign(addresses, { [artifacts[index].id]: deployment.options.address }),
        t.context.addresses || {}
      )
    })
  }
}

/**
 * Deploys a full DAO with a set of apps, permissions and dependencies included.
 *
 * Deployed base contracts:
 * - Kernel
 * - KernelProxy
 * - APM & ENS
 *
 * Deployed apps:
 * - CounterFwd (stub.aragonpm.test)
 *
 * Permissions:
 * - Deployer (e) has direct access to app #0
 * - App #3 -> App #2 -> App #1
 * - App #4 -> App #1
 * - App #6 -> App #3
 * - e -> App #3
 * - e -> App #4
 */
export async function deployDAO (t) {
  const owner = t.context.accounts[0]

  // Deploy base contracts for APM
  t.log('Deploying base APM contracts')
  const bases = [
    'APMRegistry',
    'Repo',
    'ENSSubdomainRegistrar',
    'ENSFactory'
  ].map((name) => getContractArtifact(name, name, owner))
  await deploy(bases)(t)

  t.log('Deploying APM factory')
  const apmFactory = getContractArtifact(
    'APMRegistryFactory',
    'APMRegistryFactory',
    owner,
    [
      t.context.addresses['APMRegistry'],
      t.context.addresses['Repo'],
      t.context.addresses['ENSSubdomainRegistrar'],
      '0x0000000000000000000000000000000000000000',
      t.context.addresses['ENSFactory']
    ]
  )
  await deploy([apmFactory])(t)

  // Deploy APM registry
  t.log('Creating APM registry (aragonpm.eth)')
  const tld = namehash.hash('eth')
  const label = '0x' + keccak256('aragonpm')
  const rootNode = namehash.hash('aragonpm.eth')

  const apmRegistryReceipt = await t.context.contracts['APMRegistryFactory'].methods.newAPM(
    tld,
    label,
    owner
  ).send({ from: owner })

  const registryAddress = Object.values(apmRegistryReceipt.events).find(
    (log) => log.event === 'DeployAPM'
  ).returnValues.apm
  t.context.contracts['APMRegistry'] = new t.context.web3.eth.Contract(
    getContractArtifact('APMRegistry', 'APMRegistry', owner).abi,
    registryAddress
  )
  t.context.addresses['APMRegistry'] = registryAddress


  // Deploy stub app
  t.log('Deploying stub app logic')
  const stubApp = getContractArtifact(
    'CounterFwd',
    'StubApp',
    owner
  )
  await deploy([stubApp])(t)

  // Create registry for stub app and publish stub app
  t.log('Creating APM repository (stub.aragonpm.eth) and publishing 1.0.0')
  const stubAppReceipt = await t.context.contracts['APMRegistry'].methods.newRepoWithVersion(
    'stub',
    owner,
    [1, 0, 0],
    t.context.addresses['StubApp'],
    '' // TODO: Set and use file provider
  ).send({ from: owner, gas: 10e6 })

  const repoAddress = Object.values(stubAppReceipt.events).find(
    (log) => log.event === 'NewRepo'
  ).returnValues.repo
  t.context.contracts['StubAppRepo'] = new t.context.web3.eth.Contract(
    getContractArtifact('Repo', 'Repo', owner).abi,
    repoAddress
  )
  t.context.addresses['StubAppRepo'] = repoAddress

  // Deploy kernel
  t.log('Deploying kernel')
  const kernelArtifact = getContractArtifact(
    'Kernel',
    'Kernel',
    owner
  )
  await deploy([kernelArtifact])(t)
  const kernel = t.context.contracts['Kernel']

  t.log('Initialising kernel')
  await kernel.methods.initialize(owner).send()

  t.log('Giving base kernel permissions')
  const upgradeAppsRole = await kernel.methods.UPGRADE_APPS_ROLE().call()
  await kernel.methods.createPermission(
    owner,
    kernel.options.address,
    upgradeAppsRole,
    owner
  ).send()

  // Set app code
  t.log('Setting app code for stub.aragonpm.eth')
  await kernel.methods.setAppCode(
    namehash.hash('stub.aragonpm.eth'),
    t.context.addresses['StubApp']
  )

  // Deploy app proxies
  t.log('Deploying app proxies')
  const appProxyArtifact = getContractArtifact(
    'AppProxy',
    'StubApp',
    owner,
    [
      t.context.addresses['Kernel'],
      namehash.hash('stub.aragonpm.eth'),
      '0x'
    ]
  )
  for (let i = 0; i < 6; i++) {
    appProxyArtifact.id = `StubApp${i}`
    await deploy([appProxyArtifact])(t)
  }

  // Set up permissions
  t.log('Setting up app permissions')
  const addresses = t.context.addresses

  // Structure of array is [from, to]
  const perms = [
    [owner, addresses['StubApp0']],
    [owner, addresses['StubApp3']],
    [owner, addresses['StubApp4']],
    [addresses['StubApp3'], addresses['StubApp2']],
    [addresses['StubApp2'], addresses['StubApp1']],
    [addresses['StubApp4'], addresses['StubApp1']],
    [addresses['StubApp5'], addresses['StubApp3']],
  ]
  const adminRole = '0x0000000000000000000000000000000000000000000000000000000000000001'

  let createdPermissions = []
  for (let [from, to] of perms) {
    if(!createdPermissions.includes(to)) {
      await kernel.methods.createPermission(
        from,
        to,
        adminRole,
        owner
      ).send({ from: owner })
      createdPermissions.push(to)
    } else {
      await kernel.methods.grantPermission(
        from,
        to,
        adminRole
      ).send({ from: owner })
    }
  }
}
