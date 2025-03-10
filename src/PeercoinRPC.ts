import delay from 'delay';
import createDebug from 'debug';
import { CreatePeercoinRPCOptions, BitcoinFeeEstimateMode } from './types';
import { jsonRpcCmd } from './json-rpc';
import { PURE_METHODS, getWasExecutedFromError, getShouldRetry, iotsDecode } from './utils';
import { PeercoinRPCError } from './PeercoinRPCError';
import * as decoders from './decoders';
import * as t from 'io-ts';

const MAX_ATTEMPTS = 5;
const DELAY_BETWEEN_ATTEMPTS = 5000;

const debug = createDebug('peercoin-rpc');

export default class PeercoinRPC {
  constructor(readonly url: string, readonly options: CreatePeercoinRPCOptions = {}) {
    this.url = url;
    this.options = options;
  }

  private cmd(method: string, ...params: any[]): Promise<any> {
    return jsonRpcCmd(this.url, method, params);
  }

  private cmdWithRetry(method: string, ...params: any[]): Promise<any> {
    const methodIsPure = PURE_METHODS.includes(method);
    const maxAttempts = MAX_ATTEMPTS;

    const attempt: (attemptN?: number) => any = async (attemptN = 1) => {
      const getErrrorData = () => ({
        PeercoinRPC: {
          method,
          params,
          methodIsPure,
          maxAttempts,
          attempts: attemptN,
        },
      });

      try {
        const result = await this.cmd(method, ...params);
        return result;
      } catch (error) {
        const executed = getWasExecutedFromError(method, error);
        const hadEffects = !methodIsPure && executed !== false;
        const shouldRetry = !hadEffects && getShouldRetry(method, error);

        debug(`Command failed: ${error.message}`, {
          method,
          methodIsPure,
          params,
          executed,
          attemptN,
          maxAttempts,
          hadEffects,
          shouldRetry,
        });

        if (attemptN === maxAttempts) {
          throw new PeercoinRPCError(error, executed, getErrrorData());
        }

        if (shouldRetry) {
          await delay(DELAY_BETWEEN_ATTEMPTS);

          // NOTE: Stack deepening
          return attempt(attemptN + 1);
        }

        debug(`Cannot retry`, {
          method,
          methodIsPure,
          executed,
          attemptN,
          maxAttempts,
        });

        throw new PeercoinRPCError(error, executed, getErrrorData());
      }
    };

    return attempt();
  }

  private async cmdWithRetryAndDecode<A, I = unknown>(
    decoder: t.Decoder<I, A>,
    method: string,
    ...params: any[]
  ): Promise<A> {
    const result = await this.cmdWithRetry(method, ...params);

    try {
      const decoded = iotsDecode(decoder, result);

      return decoded;
    } catch (error) {
      throw Object.assign(error, { executed: true });
    }
  }

  public async sendRawTransaction(hex: string) {
    return this.cmdWithRetryAndDecode(decoders.SendRawTransactionResultDecoder, 'sendrawtransaction', hex);
  }

  // https://bitcoin-rpc.github.io/en/doc/0.17.99/rpc/wallet/sendtoaddress/
  public async sendToAddress(address: string, amount: string, comment?: string, commentTo?: string, subtractFeeFromAmount?: boolean, replaceable?: boolean) {
    const params: any[] = [address, amount];

    if (replaceable !== undefined) {
      // Argument #6
      params.push(comment ?? '', commentTo ?? '', subtractFeeFromAmount ?? false, replaceable);
    } else if (subtractFeeFromAmount !== undefined) {
      // Argument #5
      params.push(comment ?? '', commentTo ?? '', subtractFeeFromAmount);
    } else if (commentTo !== undefined) {
      // Argument #4
      params.push(comment ?? '', commentTo);
    } else if (commentTo) {
      // Argument #3
      params.push(comment);
    }

    return this.cmdWithRetryAndDecode(decoders.SendToAddressResultDecoder, 'sendtoaddress', ...params);
  }

  public async signRawTransactionWithWallet(hex: string) {
    return this.cmdWithRetryAndDecode(
      decoders.SignRawTransactionWithWalletResultDecoder,
      'signrawtransactionwithwallet',
      hex
    );
  }

  public async lockUnspent(unlock: boolean, transactions: { txid: string; vout: number }[]) {
    return this.cmdWithRetryAndDecode(decoders.LockUnspentResultDecoder, 'lockunspent', unlock, transactions);
  }

  // Arguments:
  // 1. "inputs"                (array, required) A json array of json objects
  //      [
  //        {
  //          "txid":"id",      (string, required) The transaction id
  //          "vout":n,         (numeric, required) The output number
  //          "sequence":n      (numeric, optional) The sequence number
  //        }
  //        ,...
  //      ]
  // 2. "outputs"               (array, required) a json array with outputs (key-value pairs)
  //    [
  //     {
  //       "address": x.xxx,    (obj, optional) A key-value pair. The key (string) is the bitcoin address, the value (float or string) is the amount in BCH
  //     },
  //     {
  //       "data": "hex"        (obj, optional) A key-value pair. The key must be "data", the value is hex encoded data
  //     }
  //     ,...                     More key-value pairs of the above form. For compatibility reasons, a dictionary, which holds the key-value pairs directly, is also
  //                              accepted as second parameter.
  //    ]
  // 3. locktime                  (numeric, optional, default=0) Raw locktime. Non-0 value also locktime-activates inputs
  // Result:
  // "transaction"              (string) hex string of the transaction
  public async createRawTransaction(
    inputs: { txid: string; vout: number; sequence?: number }[],
    outputs: Record<string, string>,
    lockTime?: number
  ) {
    return this.cmdWithRetryAndDecode(
      decoders.CreateRawTransactionResultDecoder,
      'createrawtransaction',
      inputs,
      outputs,
      lockTime
    );
  }

  // Arguments:
  // 1. hexstring                          (string, required) The hex string of the raw transaction
  // 2. options                            (json object, optional) for backward compatibility: passing in a true instead of an object will result in {"includeWatching":true}
  //      {
  //        "changeAddress": "str",        (string, optional, default=pool address) The bitcoin address to receive the change
  //        "changePosition": n,           (numeric, optional, default=random) The index of the change output
  //        "change_type": "str",          (string, optional, default=set by -changetype) The output type to use. Only valid if changeAddress is not specified. Options are "legacy", "p2sh-segwit", and "bech32".
  //        "includeWatching": bool,       (boolean, optional, default=true for watch-only wallets, otherwise false) Also select inputs which are watch only.
  //                                       Only solvable inputs can be used. Watch-only destinations are solvable if the public key and/or output script was imported,
  //                                       e.g. with 'importpubkey' or 'importmulti' with the 'pubkeys' or 'desc' field.
  //        "lockUnspents": bool,          (boolean, optional, default=false) Lock selected unspent outputs
  //        "feeRate": amount,             (numeric or string, optional, default=not set: makes wallet determine the fee) Set a specific fee rate in BTC/kB
  //        "subtractFeeFromOutputs": [    (json array, optional, default=empty array) A json array of integers.
  //                                       The fee will be equally deducted from the amount of each specified output.
  //                                       Those recipients will receive less bitcoins than you enter in their corresponding amount field.
  //                                       If no outputs are specified here, the sender pays the fee.
  //          vout_index,                  (numeric) The zero-based output index, before a change output is added.
  //          ...
  //        ],
  //        "replaceable": bool,           (boolean, optional, default=wallet default) Marks this transaction as BIP125 replaceable.
  //                                       Allows this transaction to be replaced by a transaction with higher fees
  //        "conf_target": n,              (numeric, optional, default=wallet default) Confirmation target (in blocks)
  //        "estimate_mode": "str",        (string, optional, default=UNSET) The fee estimate mode, must be one of:
  //                                       "UNSET"
  //                                       "ECONOMICAL"
  //                                       "CONSERVATIVE"
  //      }
  // 3. iswitness                          (boolean, optional, default=depends on heuristic tests) Whether the transaction hex is a serialized witness transaction.
  //                                       If iswitness is not present, heuristic tests will be used in decoding.
  //                                       If true, only witness deserialization will be tried.
  //                                       If false, only non-witness deserialization will be tried.
  //                                       This boolean should reflect whether the transaction has inputs
  //                                       (e.g. fully valid, or on-chain transactions), if known by the caller.
  // Result:
  // {
  //   "hex":       "value", (string)  The resulting raw transaction (hex-encoded string)
  //   "fee":       n,         (numeric) Fee in BTC the resulting transaction pays
  //   "changepos": n          (numeric) The position of the added change output, or -1
  // }
  public async fundRawTransaction(
    hex: string,
    options: {
      changeAddress?: string,
      changePosition?: number,
      change_type?: string,
      includeWatching?: boolean,
      lockUnspents?: boolean,
      feeRate?: number,
      subtractFeeFromOutputs?: number[],
      replaceable?: boolean,
      conf_target?: number,
      estimate_mode?: BitcoinFeeEstimateMode
    },
    iswitness?: boolean
  ) {
    //@todo impl with iswitness option
    return this.cmdWithRetryAndDecode(
      decoders.FundRawTransactionResultDecoder, 'fundrawtransaction', hex, options
    );
  }

  public async listTransactions(count: number) {
    return this.cmdWithRetryAndDecode(decoders.ListTransactionsDecoder, 'listtransactions', "*", count)
  }

  public async getTransaction(txhash: string) {
    return this.cmdWithRetryAndDecode(decoders.GetTransactionResultDecoder, 'gettransaction', txhash);
  }

  public async getInfo() {
    return this.cmdWithRetryAndDecode(decoders.GetInfoResultDecoder, 'getinfo');
  }

  public async getBlockchainInfo() {
    return this.cmdWithRetryAndDecode(decoders.GetBlockchainInfoResultDecoder, 'getblockchaininfo');
  }

  public async getRawTransactionAsObject(txhash: string) {
    return this.cmdWithRetryAndDecode(decoders.GetRawTransactionAsObjectResultDecoder, 'getrawtransaction', txhash, 1);
  }

  public async getBlockHashFromHeight(height: number) {
    return this.cmdWithRetryAndDecode(decoders.GetBlockHashFromHeightResultDecoder, 'getblockhash', height);
  }

  public async getBlockFromHash(blockHash: string) {
    return this.cmdWithRetryAndDecode(decoders.GetBlockFromHashResultDecoder, 'getblock', blockHash);
  }

  public async getRawMempool() {
    return this.cmdWithRetryAndDecode(decoders.GetRawMempoolResultDecoder, 'getrawmempool');
  }

  public async validateAddress(address: string) {
    return this.cmdWithRetryAndDecode(decoders.ValidateAddressResultDecoder, 'validateaddress', address);
  }

  public async getNewAddress() {
    return this.cmdWithRetryAndDecode(decoders.GetNewAddressResultDecoder, 'getnewaddress');
  }

  public async getBalance() {
    return this.cmdWithRetryAndDecode(decoders.GetBalanceResultDecoder, 'getbalance');
  }

  public async generateToAddress(nblocks: number, address:string) {
    return this.cmdWithRetryAndDecode(decoders.GenerateToAddressResultDecoder, 'generatetoaddress', nblocks, address);
  }

  public async ancientGetInfo() {
    return this.cmdWithRetryAndDecode(decoders.AncientGetInfoResultDecoder, 'getinfo');
  }

  public async listUnspent(minConf?: number) {
    const args: any[] = minConf === undefined ? [] : [minConf];

    return this.cmdWithRetryAndDecode(decoders.ListUnspentDecoder, 'listunspent', ...args);
  }

  public async dumpPrivateKey(address: string) {
    return this.cmdWithRetryAndDecode(decoders.DumpPrivateKeyDecoder, 'dumpprivkey', address);
  }

  public async isReady() {
    try {
      if (this.options.ancient === true) {
        await this.ancientGetInfo();
      } else {
        await this.getBlockchainInfo();
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  public async getReceivedByAddress(address: string) {
    return this.cmdWithRetryAndDecode(decoders.GetBalanceResultDecoder, 'getreceivedbyaddress', address);
  }
}
