import { Text, type TextProps } from '@/components/text';
import { codeSpans } from '@/lib/code-spans';

/** Text from the CLI with its `backticked` commands in monospace. */
export function CodeText({ children, ...props }: Omit<TextProps, 'children'> & { children: string }) {
  return (
    <Text {...props}>
      {codeSpans(children).map((span, index) =>
        span.code ? (
          <Text key={index} {...props} mono>
            {span.text}
          </Text>
        ) : (
          span.text
        ),
      )}
    </Text>
  );
}
