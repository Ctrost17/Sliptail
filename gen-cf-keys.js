const { generateKeyPairSync } = require('crypto');
const fs = require('fs');

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },   // BEGIN PUBLIC KEY
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }    // BEGIN PRIVATE KEY (PKCS#8)
});

fs.writeFileSync('cf_public_key.pem', publicKey);
fs.writeFileSync('cf_private_key.pem', privateKey);

console.log('Wrote cf_public_key.pem and cf_private_key.pem');