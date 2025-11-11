"use client";

import Button from "@/components/shared/button/button";
import GithubIcon from "./_svg/GithubIcon";

export default function HeaderGithubClient() {
  return (
    <a
      className="contents"
      href="https://github.com/nuvia-ai/nuvia"
      target="_blank"
    >
      <Button variant="tertiary">
        <GithubIcon />
        Star
      </Button>
    </a>
  );
}
