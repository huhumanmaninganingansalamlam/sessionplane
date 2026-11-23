export type PreparationPurpose = 'model' | 'effort' | 'composer' | 'submit';

export interface PreparationTarget {
  readonly purpose: PreparationPurpose;
  readonly configurationVersion?: string;
  readonly configurationVerification?: {
    readonly version: string;
    readonly effort: string;
    readonly surface: 'chat';
  };
  readonly submitGesture?: 'enter';
  readonly id: string;
  readonly role: string;
  readonly ancestorIds: readonly string[];
  readonly name: string;
  readonly tag: string;
  readonly text: string;
  readonly placeholder: string | null;
  readonly selected: boolean | null;
  readonly checked: boolean | null;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly ariaValueText: string | null;
  readonly ariaValueNow: string | null;
  readonly ariaValueMin: string | null;
  readonly ariaValueMax: string | null;
  readonly selectedValue: number | null;
  readonly description: string;
  readonly controls: readonly string[];
  readonly describedBy: readonly string[];
  readonly labelledBy: readonly string[];
}

export type PreparationChoices = Readonly<
  Partial<Record<PreparationPurpose, PreparationTarget>>
>;
