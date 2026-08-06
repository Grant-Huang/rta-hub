/**
 * 规格整包 —— 一个 `ProductSpecVersion` 下的全部规格内容。
 *
 * 为什么整包存：这些实体的生命周期完全绑定在版本上（版本发布后一律不可变，
 * §3.6），永远一起读、一起写，拆成六个文件只会增加一致性风险。
 */
import type {
  AccessoryOption, DiscountRule, DoorStyle, HardwareOption, ModuleSpec,
  PriceGroup, PriceMatrixEntry, ShippingRule,
} from "../domain/types.js";
import type { PricingContext } from "../pricing/engine.js";
import type { TaxRule } from "../domain/types.js";

export interface SpecBundle {
  /** 与所属 ProductSpecVersion.id 相同，便于按 id 直接取。 */
  id: string;
  companyId: string;
  priceGroups: PriceGroup[];
  doorStyles: DoorStyle[];
  modules: ModuleSpec[];
  priceMatrix: PriceMatrixEntry[];
  hardwareOptions: HardwareOption[];
  accessoryOptions: AccessoryOption[];
  discountRules: DiscountRule[];
  shippingRule?: ShippingRule;
}

export function emptyBundle(specVersionId: string, companyId: string): SpecBundle {
  return {
    id: specVersionId, companyId,
    priceGroups: [], doorStyles: [], modules: [], priceMatrix: [],
    hardwareOptions: [], accessoryOptions: [], discountRules: [],
  };
}

/** 把整包 + 税率表组装成定价引擎需要的上下文。 */
export function toPricingContext(bundle: SpecBundle, taxRules: readonly TaxRule[]): PricingContext {
  return {
    specVersionId: bundle.id,
    companyId: bundle.companyId,
    modules: bundle.modules,
    doorStyles: bundle.doorStyles,
    priceMatrix: bundle.priceMatrix,
    hardwareOptions: bundle.hardwareOptions,
    accessoryOptions: bundle.accessoryOptions,
    discountRules: bundle.discountRules,
    ...(bundle.shippingRule ? { shippingRule: bundle.shippingRule } : {}),
    taxRules,
  };
}
