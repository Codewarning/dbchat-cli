import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { InlineTextInput } from "./chat-composer.js";
import type { ConfirmPromptRequest, InputPromptRequest, PromptRequest, SelectPromptRequest } from "./chat-ui-types.js";

function ConfirmPromptView({
  prompt,
  onResolve,
  onReject,
}: {
  prompt: ConfirmPromptRequest;
  onResolve(value: boolean): void;
  onReject(error: Error): void;
}) {
  const initialSelected = prompt.defaultValue ? 0 : 1;
  const [selectedIndex, setSelectedIndex] = useState(initialSelected);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onReject(new Error("Prompt cancelled."));
      return;
    }

    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelectedIndex((current) => (current === 0 ? 1 : 0));
      return;
    }

    if (key.return) {
      onResolve(selectedIndex === 0);
    }
  });

  const options = ["Yes", "No"];

  return (
    <Box borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow" bold>
        Confirmation Required
      </Text>
      <Text>{prompt.message}</Text>
      <Box>
        {options.map((option, index) => (
          <Box key={option} marginRight={2}>
            <Text color={index === selectedIndex ? "yellow" : "gray"}>{index === selectedIndex ? `> ${option}` : `  ${option}`}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>Use arrows to choose and Enter to confirm.</Text>
    </Box>
  );
}

function SelectPromptView({
  prompt,
  onResolve,
  onReject,
}: {
  prompt: SelectPromptRequest;
  onResolve(value: string): void;
  onReject(error: Error): void;
}) {
  const initialIndex = Math.max(0, prompt.defaultValue ? prompt.choices.findIndex((choice) => choice.value === prompt.defaultValue) : 0);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex < 0 ? 0 : initialIndex);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onReject(new Error("Prompt cancelled."));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => (current === 0 ? prompt.choices.length - 1 : current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => (current === prompt.choices.length - 1 ? 0 : current + 1));
      return;
    }

    if (key.return) {
      onResolve(prompt.choices[selectedIndex]!.value);
    }
  });

  return (
    <Box borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow" bold>
        Selection Required
      </Text>
      <Text>{prompt.message}</Text>
      <Box flexDirection="column">
        {prompt.choices.map((choice, index) => (
          <Text key={choice.value} color={index === selectedIndex ? "yellow" : "white"}>
            {index === selectedIndex ? `> ${choice.label}` : `  ${choice.label}`}
            {choice.value === prompt.defaultValue ? " (default)" : ""}
          </Text>
        ))}
      </Box>
      <Text dimColor>Use Up/Down to choose and Enter to confirm.</Text>
    </Box>
  );
}

function InputPromptView({
  prompt,
  onResolve,
  onReject,
}: {
  prompt: InputPromptRequest;
  onResolve(value: string): void;
  onReject(error: Error): void;
}) {
  const [value, setValue] = useState(prompt.defaultValue);

  return (
    <Box borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow" bold>
        Input Required
      </Text>
      <Text>{prompt.message}</Text>
      <Box>
        <InlineTextInput
          label=""
          value={value}
          placeholder={prompt.defaultValue || "Enter a value"}
          active
          secret={prompt.secret}
          onChange={setValue}
          onSubmit={() => onResolve(value)}
          onCancel={() => onReject(new Error("Prompt cancelled."))}
        />
      </Box>
      <Text dimColor>Enter to confirm. Esc clears the current input.</Text>
    </Box>
  );
}

/**
 * Render the currently pending prompt modal.
 */
export function PromptModal({
  prompt,
  onResolve,
  onReject,
}: {
  prompt: PromptRequest | null;
  onResolve(value: boolean | string): void;
  onReject(error: Error): void;
}) {
  if (!prompt) {
    return null;
  }

  if (prompt.kind === "confirm") {
    return <ConfirmPromptView prompt={prompt} onResolve={onResolve} onReject={onReject} />;
  }

  if (prompt.kind === "select") {
    return <SelectPromptView prompt={prompt} onResolve={onResolve} onReject={onReject} />;
  }

  return <InputPromptView prompt={prompt} onResolve={onResolve} onReject={onReject} />;
}
