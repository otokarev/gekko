var StellarSdk = require('stellar-sdk');
var BigNumber = require('bignumber.js');
var Poloniex = require("poloniex.js");

var util = require('../core/util.js');
var _ = require('lodash');
var moment = require('moment');
var log = require('../core/log');

var Trader = function(config) {
  _.bindAll(this);

  this.name = 'Stellar';
  this.asset = config.asset;
  this.currency = config.currency;

  this.assets = {
        details: {
            XLM: {type: 'native'},
            BTC: {type: '', code: 'BTC', issuer: 'GD5H2WSHTWVTZI5BR3V5XTRBCFDMEOKFMXR4Y4PU337K7WS55UAADI5T'}
        },
    };


  this.account = config.account;
  this.secret = config.secret;

  this.poloniexKey = config.poloniexKey;
  this.poloniexSecret = config.poloniexSecret;

  this.horizonUrl = config.env === 'development' ? 'https://horizon-testnet.stellar.org' : 'https://horizon-testnet.stellar.org';

  if (config.env === 'development') {
      StellarSdk.Network.useTestNetwork();
  } else {
      StellarSdk.Network.usePublicNetwork();
  }

  log.debug('Init', 'New Stellar Trader');

  this.stellar = new StellarSdk.Server(this.horizonUrl, { allowHttp: true });

  this.poloniex = new Poloniex(this.poloniexKey, this.poloniexSecret);
};

// if the exchange errors we try the same call again after
// waiting 10 seconds
Trader.prototype.retry = function(method, args) {
  var wait = +moment.duration(10, 'seconds');
  log.debug(this.name, 'returned an error, retrying.', args);

  var self = this;

  // make sure the callback (and any other fn)
  // is bound to Trader
  _.each(args, function(arg, i) {
    if(_.isFunction(arg))
      args[i] = _.bind(arg, self);
  });

  // run the failed method again with the same
  // arguments after wait
  setTimeout(
    function() { method.apply(self, args) },
    wait
  );
};

Trader.prototype.getPortfolio = function(callback) {
  var args = _.toArray(arguments);
  log.debug('getPortfolio', 'called');

  this.stellar.loadAccount(this.account)
      .then((result) => {
        var data = result.balances;

        var assetEntry = _.find(data, (i) => { return (this.asset === 'XLM' && i.asset_type === 'native') || i.asset_code === this.asset});
        var currencyEntry = _.find(data, (i) => { return (this.currency === 'XLM' && i.asset_type === 'native') || i.asset_code === this.currency});

        if(_.isUndefined(assetEntry) || _.isUndefined(currencyEntry)) {
            log.info('asset:', this.asset);
            log.info('currency:', this.currency);
            log.info('exchange data:', data);
            util.die('Gekko was unable to set the portfolio');
        }

        var portfolio = [
              {name: this.asset, amount: parseFloat(assetEntry.balance)},
              {name: this.currency, amount: parseFloat(currencyEntry.balance)}
          ];
        log.debug('getPortfolio', 'result:', portfolio);
        callback(null, portfolio);
      })
      .catch((error) => {
          log.error('getPortfolio', 'Error', error);
          return this.retry(this.getPortfolio, args);
      })
};

/**
 * TODO: This method copy&pasted from poloniex
 */
Trader.prototype.getTicker = function(callback) {
    var args = _.toArray(arguments);
    this.poloniex.getTicker((err, data) => {
        if(err)
            return this.retry(this.getTicker, args);

        var tick = data['BTC_STR'];

        callback(null, {
            bid: parseFloat(tick.highestBid),
            ask: parseFloat(tick.lowestAsk),
        });

    });
};

Trader.prototype.getFee = function(callback) {

  log.debug('getFee', 'called');

  // TODO: which asset/currency?
  callback(false, parseFloat(0.00001));
};

Trader.prototype.buy = function(amount, price, callback) {
  var args = _.toArray(arguments);
  log.debug('buy', 'called', {amount: amount, price: price});

  this.manageOffer({
      amount: (amount*price).toFixed(7),
      price: (1/price).toFixed(7),
      buying: this.assets.details[this.asset],
      selling:  this.assets.details[this.currency]
  })
      .then((result) => {
          result = StellarSdk.xdr.TransactionResult.fromXDR(result.result_xdr, 'base64');
          result = StellarXdrUtils.decodeManageOfferResult(
              result.result().results()[0].tr().manageOfferResult()
          );
          log.debug('buy', 'new order', result.success.offer && result.success.offer.offerId);
          callback(null, result.success.offer ? result.success.offer.offerId : null);
      })
      .catch((error) => this.handleError(error, callback, 'buy', args));
};

Trader.prototype.sell = function(amount, price, callback) {
    var args = _.toArray(arguments);
    log.debug('sell', 'called', {amount: amount, price: price});

    this.manageOffer({
        amount,
        price,
        selling: this.assets.details[this.asset],
        buying:  this.assets.details[this.currency]
    })
        .then((result) => {
            result = StellarSdk.xdr.TransactionResult.fromXDR(result.result_xdr, 'base64');
            result = StellarXdrUtils.decodeManageOfferResult(
                result.result().results()[0].tr().manageOfferResult()
            );
            log.debug('sell', 'new order', result.success.offer && result.success.offer.offerId);
            callback(null, result.success.offer ? result.success.offer.offerId : null);
        })
        .catch((error) => this.handleError(error, callback, 'sell', args));
};

Trader.prototype.checkOrder = function(order, callback) {
    this.getOffer(order, (error, offer) => {
        callback(error, !offer);
    }) ;
};

Trader.prototype.getOrder = function(order, callback) {
    log.debug('getOrder', 'called');
    this.getOffer(order, (error, offer) => {
        if (offer) {
            log.debug(offer);
            //TODO: not clear what this method should return
            callback(error, {
                price: '',
                amount: '',
                date: '',
            });
        } else {
            callback(error, {
                price: 0,
                amount: 0,
                date: moment(0),
            });
        }
    }) ;
};

Trader.prototype.cancelOrder = function(order, callback) {
    var args = _.toArray(arguments);
    log.debug('cancelOrder', 'called');

    //this.manageOffer({id: order, amount: 0, price: 1, buying: this.assets.details[this.currency], selling:  this.assets.details[this.asset]})
    //    .then(() => {
    //        log.debug('cancelOrder', 'canceled', order);
    //        callback();
    //    })
    //    .catch((error) => {
    //        if (JSON.stringify(error).match(/op_offer_not_found/)) {
    //            callback();
    //        } else {
    //            throw error;
    //        }
    //    })
    //    .catch((error) => this.handleError(error, callback, 'cancelOrder'));

    /**
     * We cannot guarantee (gekko can lose info about created offer - ECONNABORTED) that there is no untraced offers left alive in Stellar
     * So to be sure about our current state let's drop all offers.
     * No offers, no problems
     */
    this.dropOffers()
        .catch((error) => {
            return this.retry(this.cancelOrder, args);
        })
        .then(() => {
            callback();
        })
};

Trader.prototype.handleError = function (error, callback, methodName, args) {
    if (JSON.stringify(error).match(/tx_bad_seq/)) {
        log.debug(methodName, '`tx_bad_seq` caught', 'retry');
        return this.retry(this[methodName], args);
    } else {
        log.error(methodName, 'Error', JSON.stringify(error, null, 2));
        log.error(methodName, 'failed');
        console.log(error);
        callback(error);
    }
}

/**
 * This method copy&pasted from poloniex
 */
Trader.prototype.getTrades = function(since, callback, descending) {

    var firstFetch = !!since;

    var args = _.toArray(arguments);
    var process = function(err, result) {
        if(err) {
            return this.retry(this.getTrades, args);
        }

        // Edge case, see here:
        // @link https://github.com/askmike/gekko/issues/479
        if(firstFetch && _.size(result) === 50000)
            util.die(
                [
                    'Poloniex did not provide enough data. Read this:',
                    'https://github.com/askmike/gekko/issues/479'
                ].join('\n\n')
            );

        result = _.map(result, function(trade) {
            return {
                tid: trade.tradeID,
                amount: +trade.amount,
                date: moment.utc(trade.date).unix(),
                price: +trade.rate
            };
        });

        callback(null, result.reverse());
    };

    var params = {
        currencyPair: 'BTC_STR',
    }

    if(since)
        params.start = since.unix();

    this.poloniex._public('returnTradeHistory', params, _.bind(process, this));
}

Trader.getCapabilities = function() {
  return {
    name: 'stellar',
    slug: 'stellar',
    currencies: ['BTC'],
    assets: ['XLM'],
    markets: [
        { pair: ['BTC','XLM'], minimalOrder: { amount: 0.0000001, unit: 'asset' }}
    ],
    requires: ['account', 'secret', 'env'],
    tid: 'tid',
    providesHistory: 'date',
    providesFullHistory: false,
    tradable: true,
    forceReorderDelay: false,
  };
};

Trader.prototype.dropOffers = function () {
    return this.stellar.offers('accounts', this.account)
        .call()
        .then((result) => {
            if (!result || !result.records || !result.records.length) {
                return;
            }

            return this.stellar.loadAccount(this.account)
                .then((sourceAccount) => {
                    const builder = new StellarSdk.TransactionBuilder(sourceAccount)
                    result.records.map((o) => {
                        return  StellarSdk.Operation.manageOffer({
                            price: 1,
                            offerId: o.id,
                            selling: StellarSdk.Asset.native(),
                            buying: new StellarSdk.Asset(this.assets.details['BTC'].code, this.assets.details['BTC'].issuer),
                            amount: "0",
                        });
                    }).forEach(o => builder.addOperation(o));
                    const txn = builder.build();
                    txn.sign(StellarSdk.Keypair.fromSecret(this.secret));

                    return this.stellar.submitTransaction(txn);
                })
        });
}

Trader.prototype.manageOffer = function ({id, selling, buying, amount, price}) {
    return this.stellar.loadAccount(this.account)
        .then((sourceAccount) => {
            const operation =  StellarSdk.Operation.manageOffer({
                price,
                offerId: id,
                selling:
                    selling.type === 'native'
                        ? StellarSdk.Asset.native()
                        : new StellarSdk.Asset(selling.code, selling.issuer),
                buying:
                    buying.type === 'native'
                        ? StellarSdk.Asset.native()
                        : new StellarSdk.Asset(buying.code, buying.issuer),
                amount: amount.toString(),
            });

            const txn = new StellarSdk.TransactionBuilder(sourceAccount)
                .addOperation(operation)
                .build();

            txn.sign(StellarSdk.Keypair.fromSecret(this.secret));

            return this.stellar.submitTransaction(txn);
        })
}

Trader.prototype.getOffer = function (offerId, callback) {
    this.stellar.offers('accounts', this.account)
        .call()
        .then(function (results) {
            const offer = _.find(results.records, (o) => parseInt(o.id) === parseInt(offerId));
            callback(null, offer);
        });
};


class StellarXdrUtils {
    static decodePrice (price) {
        let n = new BigNumber(price.n());
        return n.div(new BigNumber(price.d())).toString();
    }

    static decodeAccountId(account) {
        return StellarSdk.StrKey.encodeEd25519PublicKey(account.ed25519());
    }

    static lowerFirst(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    static decodeAsset(asset) {
        const assetType = StellarXdrUtils.lowerFirst(asset.switch().name.substring(9));
        switch (assetType) {
            case 'native':
                return {
                    assetType,
                };
            case 'creditAlphanum4':
                return {
                    assetType,
                    assetCode: asset.alphaNum4().assetCode().toString().substring(0, 3),
                    issuer: this.decodeAccountId(asset.alphaNum4().issuer()),
                };
            case 'creditAlphanum12':
                return {
                    assetType,
                    assetCode: asset.alphaNum12().assetCode().toString().substring(0, 3),
                    issuer: this.decodeAccountId(asset.alphaNum12().issuer()),
                };
        }
    }

    static decodeOfferEntry(offer) {
        const result = {};
        Object.keys(offer._attributes).forEach((key) => {
            let value;
            switch (key) {
                case 'sellerId':
                    value = this.decodeAccountId(offer.sellerId());
                    break;
                case 'offerId':
                    value = offer.offerId().toString();
                    break;
                case 'selling':
                    value = this.decodeAsset(offer.selling());
                    break;
                case 'buying':
                    value = this.decodeAsset(offer.buying());
                    break;
                case 'amount':
                    value = offer.amount().toString();
                    break;
                case 'price':
                    value = this.decodePrice(offer.price());
                    break;
            }
            result[key] = value;
        });
        return result;
    }

    static decodeClaimOfferAtom (offer) {
        const result = {};
        Object.keys(offer._attributes).forEach((key) => {
            let value;
            switch (key) {
                case 'sellerId':
                    value = this.decodeAccountId(offer.sellerId());
                    break;
                case 'offerId':
                    value = offer.offerId().toString();
                    break;
                case 'assetSold':
                    value = this.decodeAsset(offer.assetSold());
                    break;
                case 'amountSold':
                    value = offer.amountSold().toString();
                    break;
                case 'assetBought':
                    value = this.decodeAsset(offer.assetBought());
                    break;
                case 'amountBought':
                    value = offer.amountBought().toString();
                    break;
            }
            result[key] = value;
        });
        return result;
    }

    static decodeManageOfferResult(result) {
        return {
            success: {
                offersClaimed: result.success().offersClaimed().map((offer) => this.decodeClaimOfferAtom(offer)),
                offer: result.success().offer().switch().name !== 'manageOfferDeleted'
                    ? this.decodeOfferEntry(result.success().offer().offer())
                    : null,
            }
        };
    }

    static decodeTransactionMeta(transactionMeta) {
        return {
            operations: transactionMeta.operations().map(o => this.decodeOperationMeta(o)),
        };
    }

    static decodeOperationMeta (operation) {
        return {
            changes: operation.changes().map(c => this.decodeLedgerEntryChange(c)),
        };
    }

    static decodeLedgerEntryChange(change) {
        switch (change.switch().name) {
            case 'ledgerEntryUpdated':
                return {
                    updated: this.decodeLedgerEntry(change.updated()),
                };
            case 'ledgerEntryState':
                return {
                    state: this.decodeLedgerEntry(change.state()),
                };
            case 'ledgerEntryCreated':
                return {
                    created: this.decodeLedgerEntry(change.created()),
                };
            case 'ledgerEntryRemoved':
                return {
                    removed: this.decodeLedgerEntryData(change.removed()),
                };
            default:
                logger().warn('Unknown switch name for change. Skip it', {switchName: change.switch().name});
                return null;

        }
    }

    static decodeLedgerEntry(changeEntry) {
        return {
            lastModifiedLedgerSeq: changeEntry.lastModifiedLedgerSeq(),
            data: this.decodeLedgerEntryData(changeEntry.data()),
        };
    }

    static decodeLedgerEntryData(entryData) {
        switch (entryData.switch().name) {
            case 'account':
                return {
                    account: this.decodeAccountEntry(entryData.account()),
                };
            case 'trustline':
                return {
                    trustLine: this.decodeTrustLineEntry(entryData.trustLine()),
                };
            case 'offer':
                return {
                    offer: this.decodeOfferEntry(entryData.offer()),
                };
            default:
                logger().warn('Unknown switch name for entryData. Skip it', {switchName: entryData.switch().name});
                const r = {};
                r[entryData.switch().name] = null;
                return r;
        }
    }

    static decodeAccountEntry(account) {
        const result = {};
        Object.keys(account._attributes).forEach((key) => {
            let value;
            switch (key) {
                case 'accountId':
                    value = this.decodeAccountId(account.accountId());
                    break;
                case 'balance':
                    value = account.balance().toString();
                    break;
                case 'seqNum':
                    value = account.seqNum().toString();
                    break;
                case 'numSubEntries':
                    value = account.numSubEntries();
                    break;
                case 'inflationDest':
                    value = account.inflationDest();
                    break;
                case 'flags':
                    value = account.flags();
                    break;
                case 'homeDomain':
                    value = account.homeDomain();
                    break;
                case 'thresholds':
                    value = account.thresholds().toString('base64');
                    break;
                case 'signers':
                    value = account.signers();
                    break;
            }
            result[key] = value;
        });
        return result;
    }

    static decodeTrustLineEntry(trustline) {
        const result = {};
        Object.keys(trustline._attributes).forEach((key) => {
            let value;
            switch (key) {
                case 'accountId':
                    value = this.decodeAccountId(trustline.accountId());
                    break;
                case 'asset':
                    value = this.decodeAsset(trustline.asset());
                    break;
                case 'balance':
                    value = trustline.balance().toString();
                    break;
                case 'limit':
                    value = trustline.limit().toString();
                    break;
                case 'flags':
                    value = trustline.flags();
                    break;
            }
            result[key] = value;
        });
        return result;
    }
}


module.exports = Trader;
