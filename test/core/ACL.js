import test from 'ava'
import provider from '../helpers/provider'
import { deployDAO } from '../helpers/deploy'
import { Observable } from 'rxjs/Rx'
import Aragon from '../../src/wrapper/index'
import ACL from '../../src/core/ACL'

test.beforeEach(provider())
test.beforeEach(deployDAO)

test.beforeEach((t) => {
  const wrapper = new Aragon(
    t.context.addresses['Kernel'],
    t.context.accounts[0],
    t.context.provider
  )
  t.context.acl = wrapper.acl()
})

test.serial('ACL#state', (t) => {
  // Context
  const owner = t.context.accounts[0]
  const addresses = t.context.addresses

  // Role bytes
  const appStubAdmin = '0x0000000000000000000000000000000000000000000000000000000000000001'
  const kernelCreatePerms = '0x0000000000000000000000000000000000000000000000000000000000000001'
  const kernelUpgradeApps = '0x0000000000000000000000000000000000000000000000000000000000000002'

  // Expectation
  const expectedState = {
    [addresses['StubApp0']]: {
      [appStubAdmin]: [
        owner
      ]
    },
    [addresses['StubApp1']]: {
      [appStubAdmin]: [
        addresses['StubApp2'],
        addresses['StubApp4']
      ]
    },
    [addresses['StubApp2']]: {
      [appStubAdmin]: [
        addresses['StubApp3']
      ]
    },
    [addresses['StubApp3']]: {
      [appStubAdmin]: [
        owner,
        addresses['StubApp5']
      ]
    },
    [addresses['StubApp4']]: {
      [appStubAdmin]: [
        owner
      ]
    },
    [addresses['Kernel']]: {
      [kernelCreatePerms]: [
        owner
      ],
      [kernelUpgradeApps]: [
        owner
      ]
    }
  }

  // Reality
  return t.context.acl.state().skip(8).take(1)
    .toPromise()
    .then((actualState) => t.deepEqual(actualState, expectedState))
})
test.serial('ACL#isForwarder', async (t) => {
  // Forwarders
  t.true(await t.context.acl.isForwarder(t.context.addresses['StubApp0']))

  // Not forwarders
  const NOT_FORWARDER = '0xcafe1a77e84698c83ca8931f54a755176ef75f2c'
  t.false(await t.context.acl.isForwarder(NOT_FORWARDER))
})
test.serial('ACL#forwarders', (t) => {
  // TODO: Figure out a way to not skip(n) arbitrarily,
  // instead figure out a way to check if we're synced
  return t.context.acl.forwarders().skip(5).take(1)
    .toPromise()
    .then((forwarders) => t.is(forwarders.length, 6))
})
test.skip('ACL#canForward', (t) => {

})
test.skip('ACL#getTransactionPath', (t) => {

})
