const VOTER_STATE = require('../helpers/state')
const { bigExp, pct } = require('../helpers/numbers')(web3)
const getBlockNumber = require('@aragon/test-helpers/blockNumber')(web3)
const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const { encodeCallScript, EMPTY_SCRIPT } = require('@aragon/test-helpers/evmScript')
const { assertEvent, assertAmountOfEvents } = require('@aragon/test-helpers/assertEvent')(web3)
const { getEventArgument, getNewProxyAddress } = require('@aragon/test-helpers/events')

const Voting = artifacts.require('VotingMock')
const ExecutionTarget = artifacts.require('ExecutionTarget')

const ACL = artifacts.require('@aragon/os/contracts/acl/ACL')
const Kernel = artifacts.require('@aragon/os/contracts/kernel/Kernel')
const DAOFactory = artifacts.require('@aragon/os/contracts/factory/DAOFactory')
const EVMScriptRegistryFactory = artifacts.require('@aragon/os/contracts/factory/EVMScriptRegistryFactory')
const MiniMeToken = artifacts.require('@aragon/apps-shared-minime/contracts/MiniMeToken')

const getContract = name => artifacts.require(name)
const createdVoteId = receipt => getEventArgument(receipt, 'StartVote', 'voteId')

const ANY_ADDR = '0xffffffffffffffffffffffffffffffffffffffff'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('Voting App', ([root, holder1, holder2, holder20, holder29, holder51, nonHolder]) => {
    let votingBase, daoFact, voting, token, executionTarget

    let APP_MANAGER_ROLE
    let CREATE_VOTES_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE, MODIFY_EARLY_EXECUTION_ROLE

    const NOW = 1553703809  // random fixed timestamp in seconds
    const ONE_DAY = 60 * 60 * 24
    const VOTING_DURATION = ONE_DAY * 5

    before(async () => {
        const kernelBase = await getContract('Kernel').new(true) // petrify immediately
        const aclBase = await getContract('ACL').new()
        const regFact = await EVMScriptRegistryFactory.new()
        daoFact = await DAOFactory.new(kernelBase.address, aclBase.address, regFact.address)
        votingBase = await Voting.new()

        // Setup constants
        APP_MANAGER_ROLE = await kernelBase.APP_MANAGER_ROLE()
        CREATE_VOTES_ROLE = await votingBase.CREATE_VOTES_ROLE()
        MODIFY_SUPPORT_ROLE = await votingBase.MODIFY_SUPPORT_ROLE()
        MODIFY_QUORUM_ROLE = await votingBase.MODIFY_QUORUM_ROLE()
        MODIFY_EARLY_EXECUTION_ROLE = await votingBase.MODIFY_EARLY_EXECUTION_ROLE()
    })

    beforeEach(async () => {
        const r = await daoFact.newDAO(root)
        const dao = Kernel.at(getEventArgument(r, 'DeployDAO', 'dao'))
        const acl = ACL.at(await dao.acl())

        await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })

        const receipt = await dao.newAppInstance('0x1234', votingBase.address, '0x', false, { from: root })
        voting = Voting.at(getNewProxyAddress(receipt))
        await voting.mockSetTimestamp(NOW)

        await acl.createPermission(ANY_ADDR, voting.address, CREATE_VOTES_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDR, voting.address, MODIFY_SUPPORT_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDR, voting.address, MODIFY_QUORUM_ROLE, root, { from: root })
        await acl.createPermission(ANY_ADDR, voting.address, MODIFY_EARLY_EXECUTION_ROLE, root, { from: root })
    })

    context('normal token supply, common tests', () => {
        const neededSupport = pct(50)
        const minimumAcceptanceQuorum = pct(20)

        beforeEach(async () => {
            token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

            await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION)

            executionTarget = await ExecutionTarget.new()
        })

        it('fails on reinitialization', async () => {
            await assertRevert(voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION))
        })

        it('cannot initialize base app', async () => {
            const newVoting = await Voting.new()
            assert.isTrue(await newVoting.isPetrified())
            await assertRevert(newVoting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION))
        })

        it('checks it is forwarder', async () => {
            assert.isTrue(await voting.isForwarder())
        })

        it('can change required support', async () => {
            const receipt = await voting.changeSupportRequiredPct(neededSupport.add(1))
            assertAmountOfEvents(receipt, 'ChangeSupportRequired')

            assert.equal((await voting.supportRequiredPct()).toString(), neededSupport.add(1).toString(), 'should have changed required support')
        })

        it('fails changing required support lower than minimum acceptance quorum', async () => {
            await assertRevert(voting.changeSupportRequiredPct(minimumAcceptanceQuorum.minus(1)))
        })

        it('fails changing required support to 100% or more', async () => {
            await assertRevert(voting.changeSupportRequiredPct(pct(101)))
            await assertRevert(voting.changeSupportRequiredPct(pct(100)))
        })

        it('can change minimum acceptance quorum', async () => {
            const receipt = await voting.changeMinAcceptQuorumPct(1)
            assertAmountOfEvents(receipt, 'ChangeMinQuorum')

            assert.equal(await voting.minAcceptQuorumPct(), 1, 'should have changed acceptance quorum')
        })

        it('fails changing minimum acceptance quorum to greater than min support', async () => {
            await assertRevert(voting.changeMinAcceptQuorumPct(neededSupport.plus(1)))
        })

        it('can change the early execution setting', async () => {
            assert.isTrue(await voting.isEarlyExecutionAllowed(), 'early execution should be allowed by default')

            const receipt = await voting.changeEarlyExecution(false)
            assertAmountOfEvents(receipt, 'ChangeEarlyExecution')
            assertEvent(receipt, 'ChangeEarlyExecution', { allowed: false })

            assert.isFalse(await voting.isEarlyExecutionAllowed(), 'early execution should be disallowed')
        })

        it('fails trying to set the same early execution setting', async () => {
            await assertRevert(voting.changeEarlyExecution(true), 'VOTING_SAME_EARLY_EXECUTION')
        })
    })

    for (const decimals of [0, 2, 18, 26]) {
        context(`normal token supply, ${decimals} decimals`, () => {
            const neededSupport = pct(50)
            const minimumAcceptanceQuorum = pct(20)

            beforeEach(async () => {
                token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

                await token.generateTokens(holder20, bigExp(20, decimals))
                await token.generateTokens(holder29, bigExp(29, decimals))
                await token.generateTokens(holder51, bigExp(51, decimals))

                await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION)

                executionTarget = await ExecutionTarget.new()
            })

            it('deciding voting is automatically executed', async () => {
                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                const script = encodeCallScript([action])
                await voting.newVote(script, '', { from: holder51 })
                assert.equal(await executionTarget.counter(), 1, 'should have received execution call')
            })

            it('deciding voting is automatically executed (long version)', async () => {
                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                const script = encodeCallScript([action])
                await voting.newVoteExt(script, '', true, true, { from: holder51 })
                assert.equal(await executionTarget.counter(), 1, 'should have received execution call')
            })

            it('execution scripts can execute multiple actions', async () => {
                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                const script = encodeCallScript([action, action, action])
                await voting.newVote(script, '', { from: holder51 })
                assert.equal(await executionTarget.counter(), 3, 'should have executed multiple times')
            })

            it('execution script can be empty', async () => {
                await voting.newVote(encodeCallScript([]), '', { from: holder51 })
            })

            it('execution throws if any action on script throws', async () => {
                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                let script = encodeCallScript([action])
                script = script.slice(0, -2) // remove one byte from calldata for it to fail
                await assertRevert(voting.newVote(script, '', { from: holder51 }))
            })

            it('forwarding creates vote', async () => {
                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                const script = encodeCallScript([action])
                const voteId = createdVoteId(await voting.forward(script, { from: holder51 }))
                assert.equal(voteId, 0, 'voting should have been created')
            })

            context('creating vote', () => {
                let script, voteId, creator, metadata

                beforeEach(async () => {
                    const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                    script = encodeCallScript([action, action])

                    const receipt = await voting.newVoteExt(script, 'metadata', false, false, { from: holder51 });
                    voteId = getEventArgument(receipt, 'StartVote', 'voteId')
                    creator = getEventArgument(receipt, 'StartVote', 'creator')
                    metadata = getEventArgument(receipt, 'StartVote', 'metadata')
                })

                it('has correct state', async () => {
                    const [isOpen, isExecuted, startDate, snapshotBlock, supportRequired, minQuorum, y, n, votingPower, execScript] = await voting.getVote(voteId)

                    assert.isTrue(isOpen, 'vote should be open')
                    assert.isFalse(isExecuted, 'vote should not be executed')
                    assert.equal(creator, holder51, 'creator should be correct')
                    assert.equal(snapshotBlock.toString(), await getBlockNumber() - 1, 'snapshot block should be correct')
                    assert.equal(supportRequired.toString(), neededSupport.toString(), 'required support should be app required support')
                    assert.equal(minQuorum.toString(), minimumAcceptanceQuorum.toString(), 'min quorum should be app min quorum')
                    assert.equal(y, 0, 'initial yea should be 0')
                    assert.equal(n, 0, 'initial nay should be 0')
                    assert.equal(votingPower.toString(), bigExp(100, decimals).toString(), 'voting power should be 100')
                    assert.equal(execScript, script, 'script should be correct')
                    assert.equal(metadata, 'metadata', 'should have returned correct metadata')
                    assert.equal(await voting.getVoterState(voteId, nonHolder), VOTER_STATE.ABSENT, 'nonHolder should not have voted')
                })

                it('fails getting a vote out of bounds', async () => {
                    await assertRevert(voting.getVote(voteId + 1))
                })

                it('changing required support does not affect vote required support', async () => {
                    await voting.changeSupportRequiredPct(pct(70))

                    // With previous required support at 50%, vote should be approved
                    // with new quorum at 70% it shouldn't have, but since min quorum is snapshotted
                    // it will succeed

                    await voting.vote(voteId, true, false, { from: holder51 })
                    await voting.vote(voteId, true, false, { from: holder20 })
                    await voting.vote(voteId, false, false, { from: holder29 })
                    await voting.mockIncreaseTime(VOTING_DURATION + 1)

                    const state = await voting.getVote(voteId)
                    assert.equal(state[4].toString(), neededSupport.toString(), 'required support in vote should stay equal')
                    await voting.executeVote(voteId) // exec doesn't fail
                })

                it('changing min quorum doesnt affect vote min quorum', async () => {
                    await voting.changeMinAcceptQuorumPct(pct(50))

                    // With previous min acceptance quorum at 20%, vote should be approved
                    // with new quorum at 50% it shouldn't have, but since min quorum is snapshotted
                    // it will succeed

                    await voting.vote(voteId, true, true, { from: holder29 })
                    await voting.mockIncreaseTime(VOTING_DURATION + 1)

                    const state = await voting.getVote(voteId)
                    assert.equal(state[5].toString(), minimumAcceptanceQuorum.toString(), 'acceptance quorum in vote should stay equal')
                    await voting.executeVote(voteId) // exec doesn't fail
                })

                it('holder can vote', async () => {
                    await voting.vote(voteId, false, true, { from: holder29 })
                    const state = await voting.getVote(voteId)
                    const voterState = await voting.getVoterState(voteId, holder29)

                    assert.equal(state[7].toString(), bigExp(29, decimals).toString(), 'nay vote should have been counted')
                    assert.equal(voterState, VOTER_STATE.NAY, 'holder29 should have nay voter status')
                })

                it('holder can modify vote', async () => {
                    await voting.vote(voteId, true, true, { from: holder29 })
                    await voting.vote(voteId, false, true, { from: holder29 })
                    await voting.vote(voteId, true, true, { from: holder29 })
                    const state = await voting.getVote(voteId)

                    assert.equal(state[6].toString(), bigExp(29, decimals).toString(), 'yea vote should have been counted')
                    assert.equal(state[7], 0, 'nay vote should have been removed')
                })

                it('token transfers dont affect voting', async () => {
                    await token.transfer(nonHolder, bigExp(29, decimals), { from: holder29 })

                    await voting.vote(voteId, true, true, { from: holder29 })
                    const state = await voting.getVote(voteId)

                    assert.equal(state[6].toString(), bigExp(29, decimals).toString(), 'yea vote should have been counted')
                    assert.equal(await token.balanceOf(holder29), 0, 'balance should be 0 at current block')
                })

                it('throws when non-holder votes', async () => {
                    await assertRevert(voting.vote(voteId, true, true, { from: nonHolder }))
                })

                it('throws when voting after voting closes', async () => {
                    await voting.mockIncreaseTime(VOTING_DURATION + 1)
                    await assertRevert(voting.vote(voteId, true, true, { from: holder29 }))
                })

                it('can execute if vote is approved with support and quorum', async () => {
                    await voting.vote(voteId, true, true, { from: holder29 })
                    await voting.vote(voteId, false, true, { from: holder20 })
                    await voting.mockIncreaseTime(VOTING_DURATION + 1)
                    await voting.executeVote(voteId)
                    assert.equal(await executionTarget.counter(), 2, 'should have executed result')
                })

                it('cannot execute vote if not enough quorum met', async () => {
                    await voting.vote(voteId, true, true, { from: holder20 })
                    await voting.mockIncreaseTime(VOTING_DURATION + 1)
                    await assertRevert(voting.executeVote(voteId))
                })

                it('cannot execute vote if not support met', async () => {
                    await voting.vote(voteId, false, true, { from: holder29 })
                    await voting.vote(voteId, false, true, { from: holder20 })
                    await voting.mockIncreaseTime(VOTING_DURATION + 1)
                    await assertRevert(voting.executeVote(voteId))
                })

                it('vote can be executed automatically if decided', async () => {
                    await voting.vote(voteId, true, true, { from: holder51 }) // causes execution
                    assert.equal(await executionTarget.counter(), 2, 'should have executed result')
                })

                it('cannot early execute vote when early execution is disallow even when decided', async () => {
                    await voting.changeEarlyExecution(false)
                    await voting.vote(voteId, true, true, { from: holder51 })

                    const [isOpen, isExecuted] = await voting.getVote(voteId)
                    assert.isTrue(isOpen, 'vote should still be open')
                    assert.isFalse(isExecuted, 'vote should have not been executed')
                    assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

                    await voting.mockIncreaseTime(VOTING_DURATION + 1)
                    await voting.executeVote(voteId)
                    assert.equal(await executionTarget.counter(), 2, 'should have executed result')
                })

                it('vote can be not executed automatically if decided', async () => {
                    await voting.vote(voteId, true, false, { from: holder51 }) // doesnt cause execution
                    await voting.executeVote(voteId)
                    assert.equal(await executionTarget.counter(), 2, 'should have executed result')
                })

                it('cannot re-execute vote', async () => {
                    await voting.vote(voteId, true, true, { from: holder51 }) // causes execution
                    await assertRevert(voting.executeVote(voteId))
                })

                it('cannot vote on executed vote', async () => {
                    await voting.vote(voteId, true, true, { from: holder51 }) // causes execution
                    await assertRevert(voting.vote(voteId, true, true, { from: holder20 }))
                })
            })
        })
    }

    context('wrong initializations', () => {
        beforeEach(async() => {
            token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime
        })

        it('fails if min acceptance quorum is greater than min support', async () => {
            const neededSupport = pct(20)
            const minimumAcceptanceQuorum = pct(50)
            await assertRevert(voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION))
        })

        it('fails if min support is 100% or more', async () => {
            const minimumAcceptanceQuorum = pct(20)
            await assertRevert(voting.initialize(token.address, pct(101), minimumAcceptanceQuorum, VOTING_DURATION))
            await assertRevert(voting.initialize(token.address, pct(100), minimumAcceptanceQuorum, VOTING_DURATION))
        })
    })

    context('empty token', () => {
        const neededSupport = pct(50)
        const minimumAcceptanceQuorum = pct(20)

        beforeEach(async() => {
            token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

            await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION)
        })

        it('fails creating a survey if token has no holder', async () => {
            await assertRevert(voting.newVote(EMPTY_SCRIPT, 'metadata'))
        })
    })

    context('token supply = 1', () => {
        const neededSupport = pct(50)
        const minimumAcceptanceQuorum = pct(20)

        beforeEach(async () => {
            token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

            await token.generateTokens(holder1, 1)

            await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION)
        })

        it('new vote cannot be executed before voting', async () => {
            // Account creating vote does not have any tokens and therefore doesn't vote
            const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))

            assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

            await voting.vote(voteId, true, true, { from: holder1 })

            const [isOpen, isExecuted] = await voting.getVote(voteId)

            assert.isFalse(isOpen, 'vote should be closed')
            assert.isTrue(isExecuted, 'vote should have been executed')

        })

        context('new vote parameters', () => {
            context('when early execution is allowed', () => {
                it('creates and executes a vote if voter allows execution', async () => {
                    const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, true, { from: holder1 }))
                    const [isOpen, isExecuted] = await voting.getVote(voteId)

                    assert.isFalse(isOpen, 'vote should be closed')
                    assert.isTrue(isExecuted, 'vote should have been executed')
                })

                it('creates a vote without executing it if voter does not allow execution', async () => {
                    const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, false, { from: holder1 }))
                    const [isOpen, isExecuted] = await voting.getVote(voteId)

                    assert.isTrue(isOpen, 'vote should be open')
                    assert.isFalse(isExecuted, 'vote should not have been executed')
                })
            })

            context('when early execution is not allowed', () => {
                beforeEach('disallow early execution', async () => {
                    await voting.changeEarlyExecution(false)
                })

                it('creates a vote without executing it even if voter allows execution', async () => {
                    const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, true, { from: holder1 }))
                    const [isOpen, isExecuted] = await voting.getVote(voteId)

                    assert.isTrue(isOpen, 'vote should be open')
                    assert.isFalse(isExecuted, 'vote should not have been executed')
                })

                it('creates a vote without executing it if voter does not allow execution', async () => {
                    const voteId = createdVoteId(await voting.newVoteExt(EMPTY_SCRIPT, 'metadata', true, false, { from: holder1 }))
                    const [isOpen, isExecuted] = await voting.getVote(voteId)

                    assert.isTrue(isOpen, 'vote should be open')
                    assert.isFalse(isExecuted, 'vote should not have been executed')
                })
            })
        })
    })

    context('token supply = 3', () => {
        const neededSupport = pct(34)
        const minimumAcceptanceQuorum = pct(20)

        beforeEach(async () => {
            token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

            await token.generateTokens(holder1, 1)
            await token.generateTokens(holder2, 2)

            await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION)
        })

        context('when early execution is allowed', () => {
            it('new vote cannot be executed before holder2 voting', async () => {
                const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))

                assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

                await voting.vote(voteId, true, true, { from: holder1 })
                await voting.vote(voteId, true, true, { from: holder2 })

                const [isOpen, isExecuted] = await voting.getVote(voteId)

                assert.isFalse(isOpen, 'vote should be closed')
                assert.isTrue(isExecuted, 'vote should have been executed')
            })

            it('creating vote as holder2 executes vote', async () => {
                const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata', { from: holder2 }))
                const [isOpen, isExecuted] = await voting.getVote(voteId)

                assert.isFalse(isOpen, 'vote should be closed')
                assert.isTrue(isExecuted, 'vote should have been executed')
            })
        })

        context('when early execution is not allowed', () => {
            beforeEach('disallow early execution', async () => {
                await voting.changeEarlyExecution(false)
            })

            it('new vote cannot be executed even after holder2 voting', async () => {
                const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))

                await voting.vote(voteId, true, true, { from: holder1 })
                await voting.vote(voteId, true, true, { from: holder2 })

                const [isOpen, isExecuted] = await voting.getVote(voteId)

                assert.isTrue(isOpen, 'vote should still be open')
                assert.isFalse(isExecuted, 'vote should have not been executed')
                assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
            })

            it('creating vote as holder2 does not executes vote', async () => {
                const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata', { from: holder2 }))
                const [isOpen, isExecuted] = await voting.getVote(voteId)

                assert.isTrue(isOpen, 'vote should still be open')
                assert.isFalse(isExecuted, 'vote should have not been executed')
                assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
            })
        })
    })

    context('changing token supply', () => {
        const neededSupport = pct(50)
        const minimumAcceptanceQuorum = pct(20)

        beforeEach(async () => {
            token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

            await token.generateTokens(holder1, 1)
            await token.generateTokens(holder2, 1)

            await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, VOTING_DURATION)
        })

        it('uses the correct snapshot value if tokens are minted afterwards', async () => {
            // Create vote and afterwards generate some tokens
            const voteId = createdVoteId(await voting.newVote(EMPTY_SCRIPT, 'metadata'))
            await token.generateTokens(holder2, 1)

            const [isOpen, isExecuted, startDate, snapshotBlock, supportRequired, minQuorum, y, n, votingPower, execScript] = await voting.getVote(voteId)

            // Generating tokens advanced the block by one
            assert.equal(snapshotBlock.toString(), await getBlockNumber() - 2, 'snapshot block should be correct')
            assert.equal(votingPower.toString(), (await token.totalSupplyAt(snapshotBlock)).toString(), 'voting power should match snapshot supply')
            assert.equal(votingPower.toString(), 2, 'voting power should be correct')
        })

        it('uses the correct snapshot value if tokens are minted in the same block', async () => {
            // Create vote and generate some tokens in the same transaction
            // Requires the voting mock to be the token's owner
            await token.changeController(voting.address)
            const voteId = createdVoteId(await voting.newTokenAndVote(holder2, 1, 'metadata'))

            const [isOpen, isExecuted, startDate, snapshotBlock, supportRequired, minQuorum, y, n, votingPower, execScript] = await voting.getVote(voteId)

            assert.equal(snapshotBlock.toString(), await getBlockNumber() - 1, 'snapshot block should be correct')
            assert.equal(votingPower.toString(), (await token.totalSupplyAt(snapshotBlock)).toString(), 'voting power should match snapshot supply')
            assert.equal(votingPower.toString(), 2, 'voting power should be correct')
        })
    })

    context('before init', () => {
        it('fails creating a vote before initialization', async () => {
            await assertRevert(voting.newVote(encodeCallScript([]), ''))
        })
    })

    context('isValuePct unit test', async () => {
        it('tests total = 0', async () => {
            const result1 = await voting.isValuePct(0, 0, pct(50))
            assert.equal(result1, false, "total 0 should always return false")
            const result2 = await voting.isValuePct(1, 0, pct(50))
            assert.equal(result2, false, "total 0 should always return false")
        })

        it('tests value = 0', async () => {
            const result1 = await voting.isValuePct(0, 10, pct(50))
            assert.equal(result1, false, "value 0 should false if pct is non-zero")
            const result2 = await voting.isValuePct(0, 10, 0)
            assert.equal(result2, false, "value 0 should return false if pct is zero")
        })

        it('tests pct ~= 100', async () => {
            const result1 = await voting.isValuePct(10, 10, pct(100).minus(1))
            assert.equal(result1, true, "value 10 over 10 should pass")
        })

        it('tests strict inequality', async () => {
            const result1 = await voting.isValuePct(10, 20, pct(50))
            assert.equal(result1, false, "value 10 over 20 should not pass for 50%")

            const result2 = await voting.isValuePct(pct(50).minus(1), pct(100), pct(50))
            assert.equal(result2, false, "off-by-one down should not pass")

            const result3 = await voting.isValuePct(pct(50).plus(1), pct(100), pct(50))
            assert.equal(result3, true, "off-by-one up should pass")
        })
    })
})
