import type { LucideIcon } from "lucide-react";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  sample?: string;
}

// .ui-segmented 分段控件：真实 radio 承载语义与键盘操作，全局设置与模块设置共用。
export function SegmentedField<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="ui-field">
      <span id={`${props.id}-label`}>{props.label}</span>
      <div className="ui-segmented" role="radiogroup" aria-labelledby={`${props.id}-label`}>
        {props.options.map((option) => (
          <label key={option.value} data-sample={option.sample}>
            <input
              type="radio"
              name={props.id}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            {option.icon && <option.icon size={16} aria-hidden="true" />}
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}
