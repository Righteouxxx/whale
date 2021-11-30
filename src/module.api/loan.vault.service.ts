import { RpcApiError } from '@defichain/jellyfish-api-core'
import { PaginationQuery } from '@src/module.api/_core/api.query'
import {
  AuctionPagination,
  VaultActive,
  VaultLiquidation,
  VaultLiquidationBatch,
  VaultPagination,
  VaultState
} from '@defichain/jellyfish-api-core/dist/category/loan'
import { ApiPagedResponse } from '@src/module.api/_core/api.paged.response'
import {
  LoanVaultActive,
  LoanVaultLiquidated,
  LoanVaultLiquidationBatch,
  LoanVaultState,
  LoanVaultTokenAmount
} from '@whale-api-client/api/loan'
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { TokenInfo } from '@defichain/jellyfish-api-core/dist/category/token'
import { JsonRpcClient } from '@defichain/jellyfish-api-jsonrpc'
import { DeFiDCache } from '@src/module.api/cache/defid.cache'
import { parseDisplaySymbol } from '@src/module.api/token.controller'
import { ActivePrice } from '@whale-api-client/api/prices'
import { OraclePriceActiveMapper } from '@src/module.model/oracle.price.active'
import { LoanSchemeMapper } from '@src/module.model/loan.scheme'
import { DefaultLoanSchemeMapper } from '@src/module.model/default.loan.scheme'

@Injectable()
export class LoanVaultService {
  constructor (
    private readonly client: JsonRpcClient,
    private readonly deFiDCache: DeFiDCache,
    private readonly activePriceMapper: OraclePriceActiveMapper,
    private readonly loanSchemeMapper: LoanSchemeMapper,
    private readonly defaultLoanSchemeMapper: DefaultLoanSchemeMapper
  ) {
  }

  async list (query: PaginationQuery, address?: string): Promise<ApiPagedResponse<LoanVaultActive | LoanVaultLiquidated>> {
    const next = query.next !== undefined ? String(query.next) : undefined
    const size = query.size > 30 ? 30 : query.size
    const pagination: VaultPagination = {
      start: next,
      // including_start: query.next === undefined,
      limit: size
    }

    const list: Array<VaultActive | VaultLiquidation> = await this.client.loan
      .listVaults(pagination, {
        ownerAddress: address,
        verbose: true
      }) as any
    const vaults = list.map(async (vault: VaultActive | VaultLiquidation) => {
      return await this.mapLoanVault(vault)
    })

    const items = await Promise.all(vaults)
    return ApiPagedResponse.of(items, size, item => {
      return item.vaultId
    })
  }

  async get (id: string): Promise<LoanVaultActive | LoanVaultLiquidated> {
    try {
      const vault = await this.client.loan.getVault(id)
      return await this.mapLoanVault(vault)
    } catch (err) {
      if (err instanceof RpcApiError &&
        (err?.payload?.message === `Vault <${id}> not found` || err?.payload?.message === 'vaultId must be of length 64 (not 3, for \'999\')')
      ) {
        throw new NotFoundException('Unable to find vault')
      } else {
        throw new BadRequestException(err)
      }
    }
  }

  async listAuction (query: PaginationQuery): Promise<ApiPagedResponse<LoanVaultLiquidated>> {
    const next = query.next !== undefined ? String(query.next) : undefined
    const size = query.size > 30 ? 30 : query.size
    let pagination: AuctionPagination

    if (next !== undefined) {
      const vaultId = next.substr(0, 64)
      const height = next.substr(64)

      pagination = {
        start: {
          vaultId,
          height: height !== undefined ? parseInt(height) : 0
        },
        limit: size
      }
    } else {
      pagination = { limit: size }
    }

    const list = (await this.client.loan.listAuctions(pagination))
      .map(async value => await this.mapLoanAuction(value))
    const items = await Promise.all(list)

    return ApiPagedResponse.of(items, size, item => {
      return `${item.vaultId}${item.liquidationHeight}`
    })
  }

  private async mapLoanVault (details: VaultActive | VaultLiquidation): Promise<LoanVaultActive | LoanVaultLiquidated> {
    if (details.state === VaultState.IN_LIQUIDATION) {
      return await this.mapLoanAuction(details as VaultLiquidation)
    }

    const data = details as VaultActive

    const loanScheme = await this.loanSchemeMapper.get(data.loanSchemeId)
    if (loanScheme === undefined) {
      throw new NotFoundException('unable to find loan scheme')
    }
    const defaultScheme = await this.defaultLoanSchemeMapper.get()
    if (defaultScheme === undefined) {
      throw new NotFoundException('Unable to find default scheme')
    }
    return {
      vaultId: data.vaultId,
      loanScheme: { ...loanScheme, default: loanScheme.id === defaultScheme.id },
      ownerAddress: data.ownerAddress,
      state: mapLoanVaultState(data.state) as any,

      informativeRatio: data.informativeRatio.toFixed(),
      collateralRatio: data.collateralRatio.toFixed(),
      collateralValue: data.collateralValue.toFixed(),
      loanValue: data.loanValue.toFixed(),
      interestValue: data.interestValue.toFixed(),

      collateralAmounts: await this.mapTokenAmounts(data.collateralAmounts),
      loanAmounts: await this.mapTokenAmounts(data.loanAmounts),
      interestAmounts: await this.mapTokenAmounts(data.interestAmounts)
    }
  }

  private async mapLoanAuction (details: VaultLiquidation): Promise<LoanVaultLiquidated> {
    const data = details
    const loanScheme = await this.loanSchemeMapper.get(data.loanSchemeId)
    if (loanScheme === undefined) {
      throw new NotFoundException('unable to find loan scheme')
    }
    const defaultScheme = await this.defaultLoanSchemeMapper.get()
    if (defaultScheme === undefined) {
      throw new NotFoundException('Unable to find default scheme')
    }
    return {
      vaultId: data.vaultId,
      loanScheme: { ...loanScheme, default: loanScheme.id === defaultScheme.id },
      ownerAddress: data.ownerAddress,
      state: LoanVaultState.IN_LIQUIDATION,
      batchCount: data.batchCount,
      liquidationHeight: data.liquidationHeight,
      liquidationPenalty: data.liquidationPenalty,
      batches: await this.mapLiquidationBatches(data.batches)
    }
  }

  private async mapTokenAmounts (items?: string[]): Promise<LoanVaultTokenAmount[]> {
    if (items === undefined || items.length === 0) {
      return []
    }

    const tokenAmounts = items.map(value => value.split('@'))
    const tokenInfos = await this.deFiDCache
      .batchTokenInfoBySymbol(tokenAmounts.map(([_, symbol]) => symbol))

    const mappedItems = tokenAmounts.map(async ([amount, symbol]): Promise<LoanVaultTokenAmount> => {
      const result = tokenInfos[symbol]
      if (result === undefined) {
        throw new ConflictException('unable to find token')
      }

      const info = Object.values(result)[0]
      const id = Object.keys(result)[0]
      const activePrice = await this.activePriceMapper.query(`${symbol}-USD`, 1)
      return mapLoanVaultTokenAmount(id, info, amount, activePrice[0])
    })

    return (await Promise.all(mappedItems))
      .sort(a => Number.parseInt(a.id))
  }

  private async mapLiquidationBatches (batches: VaultLiquidationBatch[]): Promise<LoanVaultLiquidationBatch[]> {
    if (batches.length === 0) {
      return []
    }

    const items = batches.map(async batch => {
      return {
        index: batch.index as any, // fixed in https://github.com/DeFiCh/jellyfish/pull/805
        collaterals: await this.mapTokenAmounts(batch.collaterals),
        loan: (await this.mapTokenAmounts([batch.loan]))[0]
      }
    })

    return await Promise.all(items)
  }
}

function mapLoanVaultTokenAmount (id: string, tokenInfo: TokenInfo, amount: string, activePrice?: ActivePrice): LoanVaultTokenAmount {
  return {
    id: id,
    amount: amount,
    symbol: tokenInfo.symbol,
    symbolKey: tokenInfo.symbolKey,
    name: tokenInfo.name,
    displaySymbol: parseDisplaySymbol(tokenInfo),
    activePrice: activePrice
  }
}

function mapLoanVaultState (state: VaultState): LoanVaultState {
  switch (state) {
    case VaultState.UNKNOWN:
      return LoanVaultState.UNKNOWN
    case VaultState.ACTIVE:
      return LoanVaultState.ACTIVE
    case VaultState.FROZEN:
      return LoanVaultState.FROZEN
    case VaultState.IN_LIQUIDATION:
      return LoanVaultState.IN_LIQUIDATION
    case VaultState.MAY_LIQUIDATE:
      return LoanVaultState.MAY_LIQUIDATE
  }
}
