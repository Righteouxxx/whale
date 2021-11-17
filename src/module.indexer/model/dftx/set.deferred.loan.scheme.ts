import { Injectable, Logger } from '@nestjs/common'
import { RawBlock } from '@src/module.indexer/model/_abstract'
import { LoanScheme, CCreateLoanScheme } from '@defichain/jellyfish-transaction'
import { LoanSchemeMapper, LoanScheme as LoanSchemeModel } from '@src/module.model/loan.scheme'
import { LoanSchemeHistoryMapper, LoanSchemeHistory } from '@src/module.model/loan.scheme.history'
import { DeferredLoanSchemeMapper } from '@src/module.model/deferred.loan.scheme'
import BigNumber from 'bignumber.js'
import { NotFoundIndexerError } from '@src/module.indexer/error'
import { DfTxIndexer, DfTxTransaction } from '@src/module.indexer/model/dftx/_abstract'

@Injectable()
export class SetDeferredLoanSchemeIndexer extends DfTxIndexer<LoanScheme> {
  OP_CODE: number = CCreateLoanScheme.OP_CODE
  private readonly logger = new Logger(SetDeferredLoanSchemeIndexer.name)

  constructor (
    private readonly loanSchemeMapper: LoanSchemeMapper,
    private readonly loanSchemeHistoryMapper: LoanSchemeHistoryMapper,
    private readonly deferredLoanSchemeMapper: DeferredLoanSchemeMapper
  ) {
    super()
  }

  async index (block: RawBlock): Promise<void> {
    const list = await this.deferredLoanSchemeMapper.query(100)
    for (const each of list) {
      if (new BigNumber(block.height).gte(each.activateAfterBlock)) {
        await this.loanSchemeMapper.put(each)
        await this.deferredLoanSchemeMapper.delete(each.id)
      }
    }
  }

  async invalidate (_: RawBlock, txns: Array<DfTxTransaction<LoanScheme>>): Promise<void> {
    for (const { dftx: { data } } of txns) {
      const prevDeferredLoanScheme = await this.getCurrentLoanScheme(data.identifier)
      const prevLoanScheme = await this.getPrevLoanScheme(data.identifier)
      await this.deferredLoanSchemeMapper.put(prevDeferredLoanScheme)
      await this.loanSchemeMapper.put(prevLoanScheme)
    }
  }

  /**
   * Get previous loan scheme before current height
   */
  private async getPrevLoanScheme (loanSchemeId: string): Promise<LoanSchemeHistory> {
    const histories = await this.loanSchemeHistoryMapper.query(loanSchemeId, 1)
    if (histories.length === 0) {
      throw new NotFoundIndexerError('index', 'LoanSchemeHistory', loanSchemeId)
    }
    return histories[0]
  }

  /**
   * Get current loan scheme which is prev deferred loan scheme
   */
  private async getCurrentLoanScheme (loanSchemeId: string): Promise<LoanSchemeModel> {
    const prevDeferredLoanScheme = await this.loanSchemeMapper.get(loanSchemeId)
    if (prevDeferredLoanScheme === undefined) {
      throw new NotFoundIndexerError('index', 'LoanScheme', loanSchemeId)
    }
    return prevDeferredLoanScheme
  }
}
