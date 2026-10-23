const deny = () => { throw new Error('Real network forbidden in offline tests'); };
globalThis.fetch = deny;
for (const name of ['http', 'https']) {
  const module = require(name);
  module.request = deny;
  module.get = deny;
}
require('net').Socket.prototype.connect = deny;
require('tls').connect = deny;
