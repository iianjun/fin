# fin

Core product language used by fin.

## Storage

**Vault**:
An independent local folder that keeps financial data, configuration, and change history for one
person or one purpose.

**Change Record**:
An immutable, structured description of a creation, edit, or deletion that can be presented to the
user in natural language.

## Accounts

**Account**:
A distinct store of money or debt whose balance a user wants to track separately. Each account
holds balances in exactly one currency.

**Asset Account**:
An account that represents money the user owns, such as cash or a bank account.

**Liability Account**:
An account that represents money the user owes, such as a credit card or loan.

## Transactions

**Transaction**:
A financial event on a calendar date that the user recognizes and manages as one unit. Every
transaction is income, an expense, a transfer, or an adjustment.

**Income**:
A transaction that brings value into the vault from outside it.

**Expense**:
A transaction that sends value out of the vault. A negative expense represents a refund.

**Transfer**:
A transaction that moves value between exactly two accounts without creating income or expense.

**Adjustment**:
A transaction that establishes or corrects an account balance without representing income or
expense.

**Refund**:
A negative expense that may reference its original expense but remains valid without that
reference.

## Classification

**Category**:
A user-defined, optional label that classifies income or expense. Categories form a parent-child
hierarchy with at most three levels.

**Category Assignment**:
The allocation of all or part of a transaction amount to a category. Its origin is explicit user
input or agent inference.
