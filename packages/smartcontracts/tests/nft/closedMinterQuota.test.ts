import * as dotenv from 'dotenv'
dotenv.config()
import { expect, use } from 'chai'
import { NftClosedMinter } from '../../src/contracts/nft/nftClosedMinter'
import chaiAsPromised from 'chai-as-promised'
import { FixedArray, MethodCallOptions, hash160, toByteString } from 'scrypt-ts'
import { getOutpointString } from '../../src/lib/txTools'
import {
    getDummyGenesisTx,
    getDummySigner,
    getDummyUTXO,
} from '../utils/txHelper'
import { getKeyInfoFromWif, getPrivKey } from '../utils/privateKey'
import { nftClosedMinterCall, nftClosedMinterDeployQuota } from './closedMinter'
import {
    CatTx,
    ContractCallResult,
    ContractIns,
    TaprootSmartContract,
} from '../../src/lib/catTx'
import { getBackTraceInfo } from '../../src/lib/proof'
import { unlockTaprootContractInput } from '../utils/contractUtils'
import { btc } from '../../src/lib/btc'
import {
    NftClosedMinterProto,
    NftClosedMinterState,
} from '../../src/contracts/nft/nftClosedMinterProto'
import { CAT721Proto } from '../../src/contracts/nft/cat721Proto'
use(chaiAsPromised)

const DUST = toByteString('4a01000000000000')

export async function closedMinterUnlock<T>(
    callInfo: ContractCallResult<T>,
    preCatTx: CatTx,
    seckey,
    nftState,
    preNftClosedMinterState,
    pubkeyX,
    pubKeyPrefix,
    prePreTx,
    options: {
        errorSig?: boolean
    } = {}
) {
    const { shPreimage, prevoutsCtx, spentScripts, sighash } =
        callInfo.catTx.getInputCtx(
            callInfo.atInputIndex,
            callInfo.contractTaproot.tapleafBuffer
        )
    const backtraceInfo = getBackTraceInfo(
        // pre
        preCatTx.tx,
        prePreTx,
        callInfo.atInputIndex
    )
    const sig = btc.crypto.Schnorr.sign(seckey, sighash.hash)
    await callInfo.contract.connect(getDummySigner())
    const closedMinterFuncCall = await callInfo.contract.methods.mint(
        callInfo.catTx.state.stateHashList,
        nftState,
        pubKeyPrefix,
        pubkeyX,
        () => (options.errorSig ? toByteString('') : sig.toString('hex')),
        DUST,
        DUST,
        // pre state
        preNftClosedMinterState,
        preCatTx.getPreState(),
        //
        backtraceInfo,
        shPreimage,
        prevoutsCtx,
        spentScripts,
        {
            script: toByteString(''),
            satoshis: toByteString('0000000000000000'),
        },
        {
            fromUTXO: getDummyUTXO(),
            verify: false,
            exec: false,
        } as MethodCallOptions<NftClosedMinter>
    )
    unlockTaprootContractInput(
        closedMinterFuncCall,
        callInfo.contractTaproot,
        callInfo.catTx.tx,
        // pre tx
        preCatTx.tx,
        callInfo.atInputIndex,
        true,
        true
    )
}

// keyInfo
const keyInfo = getKeyInfoFromWif(getPrivKey())
const { addr: addrP2WPKH, seckey, xAddress, pubKeyPrefix, pubkeyX } = keyInfo
const { genesisTx, genesisUtxo } = getDummyGenesisTx(seckey, addrP2WPKH)
const genesisOutpoint = getOutpointString(genesisTx, 0)
const nftScript =
    '5120c4043a44196c410dba2d7c9288869727227e8fcec717f73650c8ceadc90877cd'

describe('Test SmartContract `NftClosedMinter` quota', () => {
    let nftClosedMinter: NftClosedMinter
    let nftClosedMinterTaproot: TaprootSmartContract
    let initNftClosedMinterStateList: FixedArray<NftClosedMinterState, 5>
    let nftClosedMinterStateList: FixedArray<NftClosedMinterState, 5>
    let contractInsList: FixedArray<ContractIns<NftClosedMinterState>, 5>
    const collectionMax = 100n
    before(async () => {
        await NftClosedMinter.loadArtifact()
        nftClosedMinter = new NftClosedMinter(
            xAddress,
            genesisOutpoint,
            collectionMax
        )
        nftClosedMinterTaproot = TaprootSmartContract.create(nftClosedMinter)
        const quotaNumber = 5n
        const quotaStep = collectionMax / quotaNumber
        initNftClosedMinterStateList = [] as unknown as FixedArray<
            NftClosedMinterState,
            5
        >
        for (let index = 0; index < collectionMax; index += Number(quotaStep)) {
            initNftClosedMinterStateList[index / Number(quotaStep)] =
                NftClosedMinterProto.create(
                    nftScript,
                    BigInt(index) + quotaStep,
                    BigInt(index)
                )
        }
        nftClosedMinterStateList = initNftClosedMinterStateList
        contractInsList = await nftClosedMinterDeployQuota(
            seckey,
            genesisUtxo,
            nftClosedMinter,
            nftClosedMinterTaproot,
            initNftClosedMinterStateList
        )
    })

    it('should admin parallel mint nft until end.', async () => {
        // tx call
        for (let index = 0; index < contractInsList.length; index++) {
            const nftClosedMinterState = nftClosedMinterStateList[index]
            let contractIns = contractInsList[index]
            let prePreTx = genesisTx
            while (
                nftClosedMinterState.nextLocalId <=
                nftClosedMinterState.quotaMaxLocalId
            ) {
                // nft state
                const nftState = CAT721Proto.create(
                    hash160(toByteString('00')),
                    nftClosedMinterState.nextLocalId
                )
                const callInfo = await nftClosedMinterCall(
                    contractIns,
                    nftClosedMinterTaproot,
                    nftState
                )
                await closedMinterUnlock(
                    callInfo,
                    contractIns.catTx,
                    seckey,
                    nftState,
                    contractIns.state,
                    pubkeyX,
                    pubKeyPrefix,
                    prePreTx
                )
                prePreTx = contractIns.catTx.tx
                if (callInfo.nexts.length > 1) {
                    contractIns = callInfo
                        .nexts[0] as ContractIns<NftClosedMinterState>
                    expect(callInfo.nexts).to.be.length(2)
                } else {
                    break
                }
                nftClosedMinterState.nextLocalId += 1n
            }
        }
    })
})