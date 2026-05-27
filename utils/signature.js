const crypto = require('crypto');

/**
 * Computes the Tracksolid Pro signature for the given parameters and app secret.
 * 
 * Signature Algorithm:
 * 1. Filter out 'sign' parameter.
 * 2. Sort parameter keys in alphabetical order.
 * 3. Concatenate keys and values directly without '=' or ','.
 * 4. Prepend and append the appSecret to the concatenated string.
 * 5. Compute the MD5 hash (in uppercase).
 * 
 * @param {Object} params - The request query and body parameters.
 * @param {string} appSecret - The client app secret from Jimi/Tracksolid.
 * @returns {string} The computed 32-character uppercase MD5 signature.
 */
function computeSignature(params, appSecret) {
  if (!appSecret) {
    throw new Error('App secret is required to compute signature.');
  }

  // 1. Gather keys and filter out 'sign'
  const keys = Object.keys(params).filter(key => key !== 'sign');

  // 2. Sort keys alphabetically
  keys.sort();

  // 3. Concatenate keys and values
  let concatStr = '';
  for (const key of keys) {
    const val = params[key];
    // Tracksolid algorithm concatenates key and value if value is defined and not null
    if (val !== undefined && val !== null && val !== '') {
      // If it's an object/array, stringify it
      const stringVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
      concatStr += key + stringVal;
    }
  }

  // 4. Wrap with app secret: appSecret + concatStr + appSecret
  const wrappedStr = appSecret + concatStr + appSecret;

  // 5. MD5 hash and uppercase conversion
  return crypto.createHash('md5').update(wrappedStr, 'utf8').digest('hex').toUpperCase();
}

/**
 * Verifies that the signature in the request matches the computed signature.
 * Supports checking signature in headers, query parameters, or body.
 * 
 * @param {Object} req - The Express request object.
 * @param {string} appSecret - The client app secret.
 * @returns {boolean} True if the signature is valid or if verification is bypassed (v=0.9).
 */
function verifySignature(req, appSecret) {
  // If version is '0.9', Tracksolid does not perform signature verification
  const version = req.query.v || req.body.v;
  if (version === '0.9') {
    return true;
  }

  const incomingSign = req.query.sign || req.body.sign || req.headers['x-sign'] || req.headers['sign'];
  if (!incomingSign) {
    return false;
  }

  // Combine query and body parameters for signing
  const allParams = { ...req.query, ...req.body };

  try {
    const computedSign = computeSignature(allParams, appSecret);
    return computedSign === incomingSign.toUpperCase();
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

module.exports = {
  computeSignature,
  verifySignature
};
