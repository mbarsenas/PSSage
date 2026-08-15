# PSSage Privacy Policy — Draft

_Last updated: August 15, 2026_

PSSage is designed to analyze PowerShell source code and PowerShell error text that a user intentionally submits through ChatGPT.

## Data processed

PSSage may receive:

- PowerShell source code supplied for analysis.
- PowerShell error text supplied for diagnosis.
- Tool parameters necessary to perform the requested analysis.

## Data not intentionally requested

PSSage does not require passwords, API keys, access tokens, authentication cookies, or other secrets. Users should remove secrets from scripts and error logs before submitting them.

## Processing

Submitted text is processed by the PSSage backend to perform PowerShell parsing and static analysis. Version 0.1 does not execute the supplied PowerShell source as a user script.

## Storage

The reference implementation does not persist submitted scripts or error text to an application database. Hosting infrastructure may produce operational logs. Production logging should be configured to avoid recording tool payloads.

## Third parties

PSSage runs as a ChatGPT plugin and therefore operates in conjunction with OpenAI's services. The production hosting provider may also process ordinary network and operational metadata.

## Security

PSSage applies input-size limits and runs analysis in a constrained server environment. Users should still avoid submitting credentials or confidential material unless they are authorized to do so.

## Contact

Before public submission, replace this section with the verified developer support contact and public website used for the plugin listing.
