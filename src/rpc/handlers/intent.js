export default async function (request, proxy) {
  // TODO(onbjerg): Is this a smell?
  const transactionQueue = proxy.getWrapper().transactions

  // Get the transaction path
  const acl = proxy.getWrapper().acl()
  const path = await acl.getTransactionPath(
    proxy.address,
    request.params[0],
    request.params.slice(1)
  )

  return new Promise((resolve, reject) => {
    // Push the transaction to the wrapper
    transactionQueue.next({
      transaction: path[0],
      path,
      accept (transactionHash) {
        resolve(transactionHash)
      },
      reject () {
        reject(new Error('The transaction was not signed'))
      }
    })
  })
}
