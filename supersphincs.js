var isNode	=
	typeof process === 'object' &&
	typeof require === 'function' &&
	typeof window !== 'object' &&
	typeof importScripts !== 'function'
;


var sha512		= require('js-sha512');
var rsaSign		= require('rsasign');
var sodiumUtil	= require('sodiumutil');
var sphincs		= require('sphincs');


var nodeCrypto, Buffer;
if (isNode) {
	nodeCrypto	= eval('require')('crypto');
	Buffer		= eval('global.Buffer');
}


function deriveEncryptionKey (password, salt) {
	if (isNode) {
		return new Promise(function (resolve, reject) {
			nodeCrypto.pbkdf2(
				Buffer.from(password),
				Buffer.from(salt),
				aes.keyDerivation.iterations,
				aes.keyBytes,
				aes.keyDerivation.hashFunction,
				function (err, key) {
					if (err) {
						reject(err);
					}
					else {
						resolve(key);
					}
				}
			);
		});
	}
	else {
		return Promise.resolve().then(function () {	
			return crypto.subtle.importKey(
				'raw',
				sodiumUtil.from_string(password),
				{
					name: aes.keyDerivation.algorithm,
				},
				false,
				['deriveKey']
			);
		}).then(function (keyOrigin) {
			return crypto.subtle.deriveKey(
				{
					name: aes.keyDerivation.algorithm,
					salt: salt,
					iterations: aes.keyDerivation.iterations,
					hash: {
						name: aes.keyDerivation.hashFunction
					},
				},
				keyOrigin,
				{
					name: aes.algorithm,
					length: aes.keyBits
				},
				false,
				['encrypt', 'decrypt']
			);
		});
	}
}

function encrypt (plaintext, password) {
	var setup	= Promise.resolve().then(function () {
		var iv		= isNode ?
			nodeCrypto.randomBytes(aes.ivBytes) :
			crypto.getRandomValues(new Uint8Array(aes.ivBytes))
		;

		var salt	= isNode ?
			nodeCrypto.randomBytes(aes.keyDerivation.saltBytes) :
			crypto.getRandomValues(new Uint8Array(aes.keyDerivation.saltBytes))
		;

		return Promise.all([iv, salt, deriveEncryptionKey(password, salt)]);
	}).then(function (results) {
		return {
			iv: results[0],
			salt: results[1],
			key: results[2]
		};
	});

	if (isNode) {
		return setup.then(function (o) {
			var cipher	= nodeCrypto.createCipheriv(aes.algorithm, o.key, o.iv);
			var buf1	= cipher.update(Buffer.from(plaintext));
			var buf2	= cipher.final();
			var buf3	= cipher.getAuthTag();

			var cyphertext	= new Uint8Array(Buffer.concat([o.iv, o.salt, buf1, buf2, buf3]));

			sodiumUtil.memzero(o.iv);
			sodiumUtil.memzero(o.salt);
			sodiumUtil.memzero(o.key);
			sodiumUtil.memzero(buf1);
			sodiumUtil.memzero(buf2);
			sodiumUtil.memzero(buf3);

			return cyphertext;
		});
	}
	else {
		return setup.then(function (o) {
			return Promise.all([o, crypto.subtle.encrypt(
				{
					name: aes.algorithm,
					iv: o.iv,
					tagLength: aes.tagBits
				},
				o.key,
				plaintext
			)]);
		}).then(function (results) {
			var o			= results[0];
			var encrypted	= new Uint8Array(results[1]);

			var cyphertext	= new Uint8Array(
				aes.ivBytes + aes.keyDerivation.saltBytes + encrypted.length
			);

			cyphertext.set(o.iv);
			cyphertext.set(o.salt, aes.ivBytes);
			cyphertext.set(encrypted, aes.ivBytes + aes.keyDerivation.saltBytes);

			sodiumUtil.memzero(o.iv);
			sodiumUtil.memzero(o.salt);
			sodiumUtil.memzero(o.key);
			sodiumUtil.memzero(encrypted);

			return cyphertext;
		});
	}
}

function decrypt (cyphertext, password) {
	return Promise.resolve().then(function () {
		var iv		= new Uint8Array(cyphertext.buffer, cyphertext.byteOffset, aes.ivBytes);

		var salt	= new Uint8Array(
			cyphertext.buffer,
			cyphertext.byteOffset + aes.ivBytes,
			aes.keyDerivation.saltBytes
		);

		return Promise.all([iv, deriveEncryptionKey(password, salt)]);
	}).then(function (results) {
		var iv	= results[0];
		var key	= results[1];

		var decrypted;

		if (isNode) {
			var encrypted	= new Uint8Array(
				cyphertext.buffer,
				cyphertext.byteOffset + aes.ivBytes + aes.keyDerivation.saltBytes,
				cyphertext.length -
					aes.ivBytes -
					aes.keyDerivation.saltBytes -
					aes.tagBytes
			);

			var authTag		= new Uint8Array(
				cyphertext.buffer,
				cyphertext.byteOffset + cyphertext.length - aes.tagBytes
			);

			var decipher	= nodeCrypto.createDecipheriv(
				aes.algorithm,
				Buffer.from(key),
				Buffer.from(iv)
			);

			decipher.setAuthTag(Buffer.from(authTag));

			var buf1	= decipher.update(Buffer.from(encrypted));
			var buf2	= decipher.final();

			decrypted	= Buffer.concat([buf1, buf2]);

			sodiumUtil.memzero(buf1);
			sodiumUtil.memzero(buf2);
		}
		else {
			var encrypted	= new Uint8Array(
				cyphertext.buffer,
				cyphertext.byteOffset + aes.ivBytes + aes.keyDerivation.saltBytes
			);

			decrypted	= crypto.subtle.decrypt(
				{
					name: aes.algorithm,
					iv: iv,
					tagLength: aes.tagBits
				},
				key,
				encrypted
			);
		}

		return Promise.all([key, decrypted]);
	}).then(function (results) {
		var key			= results[0];
		var decrypted	= results[1];

		sodiumUtil.memzero(key);

		return new Uint8Array(decrypted);
	});
}


var aes	= {
	algorithm: isNode ? 'aes-256-gcm' : 'AES-GCM',
	ivBytes: 12,
	keyBytes: 32,
	keyBits: 256,
	tagBytes: 16,
	tagBits: 128,

	keyDerivation: {
		algorithm: 'PBKDF2',
		hashFunction: isNode ? 'sha512' : 'SHA-512',
		iterations: 1000000,
		saltBytes: 32
	}
};


var publicKeyBytes, privateKeyBytes, bytes, sphincsBytes;

var initiated	= Promise.all([
	sphincs.publicKeyBytes,
	sphincs.privateKeyBytes,
	sphincs.bytes
]).then(function (results) {
	sphincsBytes	= {
		publicKeyBytes: results[0],
		privateKeyBytes: results[1],
		bytes: results[2]
	};

	publicKeyBytes	= rsaSign.publicKeyBytes + sphincsBytes.publicKeyBytes;
	privateKeyBytes	= rsaSign.privateKeyBytes + sphincsBytes.privateKeyBytes;
	bytes			= rsaSign.bytes + sphincsBytes.bytes;
});


var superSphincs	= {
	publicKeyBytes: initiated.then(function () { return publicKeyBytes; }),
	privateKeyBytes: initiated.then(function () { return privateKeyBytes; }),
	bytes: initiated.then(function () { return bytes; }),
	hashBytes: Promise.resolve(64),

	hash: function (message, onlyBinary) { return initiated.then(function () {
		var messageBinary;
		var shouldClearMessageBinary	= typeof message === 'string';

		return Promise.resolve().then(function () {
			messageBinary	= sodiumUtil.from_string(message);

			if (isNode) {
				var hasher	= nodeCrypto.createHash('sha512');
				hasher.update(Buffer.from(messageBinary));

				return hasher.digest();
			}
			else {
				return crypto.subtle.digest(
					{
						name: 'SHA-512'
					},
					messageBinary
				);
			}
		}).then(function (hash) {
			if (shouldClearMessageBinary) {
				sodiumUtil.memzero(messageBinary);
			}

			var binary	= new Uint8Array(hash);

			if (onlyBinary) {
				return binary;
			}

			return {binary: binary, hex: sodiumUtil.to_hex(binary)};
		}).catch(function () {
			if (shouldClearMessageBinary) {
				sodiumUtil.memzero(messageBinary);
			}

			var hex		= sha512(sodiumUtil.to_string(message));
			var binary	= sodiumUtil.from_hex(hex);

			if (onlyBinary) {
				return binary;
			}

			return {binary: binary, hex: hex};
		});
	}); },

	keyPair: function () { return initiated.then(function () {
		return Promise.all([
			rsaSign.keyPair(),
			sphincs.keyPair()
		]).then(function (results) {
			var rsaKeyPair		= results[0];
			var sphincsKeyPair	= results[1];

			var keyPair	= {
				keyType: 'supersphincs',
				publicKey: new Uint8Array(publicKeyBytes),
				privateKey: new Uint8Array(privateKeyBytes)
			};

			keyPair.publicKey.set(rsaKeyPair.publicKey);
			keyPair.privateKey.set(rsaKeyPair.privateKey);
			keyPair.publicKey.set(sphincsKeyPair.publicKey, rsaSign.publicKeyBytes);
			keyPair.privateKey.set(sphincsKeyPair.privateKey, rsaSign.privateKeyBytes);

			sodiumUtil.memzero(sphincsKeyPair.privateKey);
			sodiumUtil.memzero(rsaKeyPair.privateKey);
			sodiumUtil.memzero(sphincsKeyPair.publicKey);
			sodiumUtil.memzero(rsaKeyPair.publicKey);

			return keyPair;
		});
	}); },

	sign: function (message, privateKey) { return initiated.then(function () {
		var shouldClearMessage	= typeof message === 'string';

		return superSphincs.signDetached(message, privateKey).then(function (signature) {
			message		= sodiumUtil.from_string(message);

			var signed	= new Uint8Array(
				bytes + message.length
			);

			signed.set(signature);
			signed.set(message, bytes);

			if (shouldClearMessage) {
				sodiumUtil.memzero(message);
			}

			sodiumUtil.memzero(signature);

			return signed;
		}).catch(function (err) {
			if (shouldClearMessage) {
				sodiumUtil.memzero(message);
			}

			throw err;
		});
	}); },

	signBase64: function (message, privateKey) { return initiated.then(function () {
		return superSphincs.sign(message, privateKey).then(function (signed) {
			var s	= sodiumUtil.to_base64(signed);
			sodiumUtil.memzero(signed);
			return s;
		});
	}); },

	signDetached: function (message, privateKey) { return initiated.then(function () {
		return superSphincs.hash(message).then(function (hash) {
			return Promise.all([
				hash,
				rsaSign.signDetached(
					hash.binary,
					new Uint8Array(privateKey.buffer, privateKey.byteOffset, rsaSign.privateKeyBytes)
				),
				sphincs.signDetached(
					hash.binary,
					new Uint8Array(privateKey.buffer, privateKey.byteOffset + rsaSign.privateKeyBytes)
				)
			]);
		}).then(function (results) {
			var hash				= results[0];
			var rsaSignature		= results[1];
			var sphincsSignature	= results[2];

			var signature	= new Uint8Array(bytes);

			signature.set(rsaSignature);
			signature.set(sphincsSignature, rsaSign.bytes);

			sodiumUtil.memzero(hash.binary);
			sodiumUtil.memzero(sphincsSignature);
			sodiumUtil.memzero(rsaSignature);

			return signature;
		});
	}); },

	signDetachedBase64: function (message, privateKey) { return initiated.then(function () {
		return superSphincs.signDetached(message, privateKey).then(function (signature) {
			var s	= sodiumUtil.to_base64(signature);
			sodiumUtil.memzero(signature);
			return s;
		});
	}); },

	open: function (signed, publicKey) { return initiated.then(function () {
		var shouldClearSigned	= typeof signed === 'string';

		return Promise.resolve().then(function () {
			signed	= sodiumUtil.from_base64(signed);

			var signature	= new Uint8Array(
				signed.buffer,
				signed.byteOffset,
				bytes
			);

			var message		= new Uint8Array(
				signed.buffer,
				signed.byteOffset + bytes
			);

			return Promise.all([message, superSphincs.verifyDetached(
				signature,
				message,
				publicKey
			)]);
		}).then(function (results) {
			var message	= new Uint8Array(results[0]);
			var isValid	= results[1];

			if (shouldClearSigned) {
				sodiumUtil.memzero(signed);
			}

			if (isValid) {
				return message;
			}
			else {
				throw new Error('Failed to open SuperSPHINCS signed message.');
			}
		}).catch(function (err) {
			if (shouldClearSigned) {
				sodiumUtil.memzero(signed);
			}

			throw err;
		});
	}); },

	openString: function (signed, publicKey) { return initiated.then(function () {
		return superSphincs.open(signed, publicKey).then(function (message) {
			var s	= sodiumUtil.to_string(message);
			sodiumUtil.memzero(message);
			return s;
		});
	}); },

	verifyDetached: function (signature, message, publicKey) { return initiated.then(function () {
		var shouldClearSignature	= typeof signature === 'string';

		return superSphincs.hash(message).then(function (hash) {
			signature	= sodiumUtil.from_base64(signature);

			return Promise.all([
				hash,
				rsaSign.verifyDetached(
					new Uint8Array(signature.buffer, signature.byteOffset, rsaSign.bytes),
					hash.binary,
					new Uint8Array(publicKey.buffer, publicKey.byteOffset, rsaSign.publicKeyBytes)
				),
				sphincs.verifyDetached(
					new Uint8Array(
						signature.buffer,
						signature.byteOffset + rsaSign.bytes,
						sphincsBytes.bytes
					),
					hash.binary,
					new Uint8Array(publicKey.buffer, publicKey.byteOffset + rsaSign.publicKeyBytes)
				)
			]);
		}).then(function (results) {
			var hash			= results[0];
			var rsaIsValid		= results[1];
			var sphincsIsValid	= results[2];

			if (shouldClearSignature) {
				sodiumUtil.memzero(signature);
			}

			sodiumUtil.memzero(hash.binary);

			return rsaIsValid && sphincsIsValid;
		}).catch(function (err) {
			if (shouldClearSignature) {
				sodiumUtil.memzero(signature);
			}

			throw err;
		});;
	}); },

	exportKeys: function (keyPair, password) {
		return initiated.then(function () {
			if (!keyPair.privateKey) {
				return null;
			}

			var rsaPrivateKey			= new Uint8Array(
				rsaSign.publicKeyBytes +
				rsaSign.privateKeyBytes
			);

			var sphincsPrivateKey		= new Uint8Array(
				sphincsBytes.publicKeyBytes +
				sphincsBytes.privateKeyBytes
			);

			var superSphincsPrivateKey	= new Uint8Array(
				publicKeyBytes +
				privateKeyBytes
			);

			rsaPrivateKey.set(new Uint8Array(
				keyPair.publicKey.buffer,
				keyPair.publicKey.byteOffset,
				rsaSign.publicKeyBytes
			));
			rsaPrivateKey.set(
				new Uint8Array(
					keyPair.privateKey.buffer,
					keyPair.privateKey.byteOffset,
					rsaSign.privateKeyBytes
				),
				rsaSign.publicKeyBytes
			);

			sphincsPrivateKey.set(new Uint8Array(
				keyPair.publicKey.buffer,
				keyPair.publicKey.byteOffset + rsaSign.publicKeyBytes
			));
			sphincsPrivateKey.set(
				new Uint8Array(
					keyPair.privateKey.buffer,
					keyPair.privateKey.byteOffset + rsaSign.privateKeyBytes
				),
				sphincsBytes.publicKeyBytes
			);

			superSphincsPrivateKey.set(keyPair.publicKey);
			superSphincsPrivateKey.set(keyPair.privateKey, publicKeyBytes);

			if (password) {
				return Promise.all([
					encrypt(rsaPrivateKey, password),
					encrypt(sphincsPrivateKey, password),
					encrypt(superSphincsPrivateKey, password)
				]).then(function (results) {
					sodiumUtil.memzero(superSphincsPrivateKey);
					sodiumUtil.memzero(sphincsPrivateKey);
					sodiumUtil.memzero(rsaPrivateKey);

					return results;
				});
			}
			else {
				return [
					rsaPrivateKey,
					sphincsPrivateKey,
					superSphincsPrivateKey
				];
			}
		}).then(function (results) {
			if (!results) {
				return {
					rsa: null,
					sphincs: null,
					superSphincs: null
				};
			}

			var rsaPrivateKey			= results[0];
			var sphincsPrivateKey		= results[1];
			var superSphincsPrivateKey	= results[2];

			var privateKeyData	= {
				rsa: sodiumUtil.to_base64(rsaPrivateKey),
				sphincs: sodiumUtil.to_base64(sphincsPrivateKey),
				superSphincs: sodiumUtil.to_base64(superSphincsPrivateKey)
			};

			sodiumUtil.memzero(superSphincsPrivateKey);
			sodiumUtil.memzero(sphincsPrivateKey);
			sodiumUtil.memzero(rsaPrivateKey);

			return privateKeyData;
		}).then(function (privateKeyData) {
			return {
				private: privateKeyData,
				public: {
					rsa: sodiumUtil.to_base64(new Uint8Array(
						keyPair.publicKey.buffer,
						keyPair.publicKey.byteOffset,
						rsaSign.publicKeyBytes
					)),
					sphincs: sodiumUtil.to_base64(new Uint8Array(
						keyPair.publicKey.buffer,
						keyPair.publicKey.byteOffset + rsaSign.publicKeyBytes
					)),
					superSphincs: sodiumUtil.to_base64(keyPair.publicKey)
				}
			};
		});
	},

	importKeys: function (keyData, password) {
		return initiated.then(function () {
			if (!keyData.private) {
				return null;
			}

			if (keyData.private.superSphincs) {
				var superSphincsPrivateKey	= sodiumUtil.from_base64(keyData.private.superSphincs);

				if (password) {
					return Promise.all([decrypt(superSphincsPrivateKey, password)]);
				}
				else {
					return [superSphincsPrivateKey];
				}
			}
			else {
				var rsaPrivateKey		= sodiumUtil.from_base64(keyData.private.rsa);
				var sphincsPrivateKey	= sodiumUtil.from_base64(keyData.private.sphincs);

				if (password) {
					return Promise.all([
						decrypt(
							rsaPrivateKey,
							typeof password === 'string' ? password : password.rsa
						),
						decrypt(
							sphincsPrivateKey,
							typeof password === 'string' ? password : password.sphincs
						)
					]);
				}
				else {
					return [rsaPrivateKey, sphincsPrivateKey];
				}
			}
		}).then(function (results) {
			var keyPair	= {
				publicKey: new Uint8Array(publicKeyBytes),
				privateKey: null
			};

			if (!results) {
				return keyPair;
			}

			keyPair.privateKey	= new Uint8Array(privateKeyBytes);

			if (results.length === 1) {
				var superSphincsPrivateKey	= results[0];

				keyPair.publicKey.set(new Uint8Array(
					superSphincsPrivateKey.buffer,
					superSphincsPrivateKey.byteOffset,
					publicKeyBytes
				));

				keyPair.privateKey.set(new Uint8Array(
					superSphincsPrivateKey.buffer,
					superSphincsPrivateKey.byteOffset + publicKeyBytes
				));
			}
			else {
				var rsaPrivateKey		= results[0];
				var sphincsPrivateKey	= results[1];

				keyPair.publicKey.set(
					new Uint8Array(
						rsaPrivateKey.buffer,
						rsaPrivateKey.byteOffset,
						rsaSign.publicKeyBytes
					)
				);
				keyPair.publicKey.set(
					new Uint8Array(
						sphincsPrivateKey.buffer,
						sphincsPrivateKey.byteOffset,
						sphincsBytes.publicKeyBytes
					),
					rsaSign.publicKeyBytes
				);

				keyPair.privateKey.set(
					new Uint8Array(
						rsaPrivateKey.buffer,
						rsaPrivateKey.byteOffset + rsaSign.publicKeyBytes
					)
				);
				keyPair.privateKey.set(
					new Uint8Array(
						sphincsPrivateKey.buffer,
						sphincsPrivateKey.byteOffset + sphincsBytes.publicKeyBytes
					),
					rsaSign.privateKeyBytes
				);
			}

			return keyPair;
		}).then(function (keyPair) {
			if (!keyPair.privateKey) {
				if (keyData.public.superSphincs) {
					keyPair.publicKey.set(sodiumUtil.from_base64(keyData.public.superSphincs));
				}
				else if (keyData.public.rsa && keyData.public.sphincs) {
					keyPair.publicKey.set(sodiumUtil.from_base64(keyData.public.rsa));
					keyPair.publicKey.set(
						sodiumUtil.from_base64(keyData.public.sphincs),
						rsaSign.publicKeyBytes
					);
				}
			}

			return keyPair;
		});
	}
};



superSphincs.superSphincs	= superSphincs;
module.exports				= superSphincs;
