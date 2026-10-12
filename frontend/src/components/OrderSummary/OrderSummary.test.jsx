import { render, screen } from '@testing-library/react';
import OrderSummary from './OrderSummary.jsx';

test('does not show a gateway fee that the customer did not pay', () => {
  render(
    <OrderSummary
      network="MTN"
      dataAmount="1GB"
      recipientPhone="0240000000"
      price={5}
      dataPrice={5}
      fee={0.1}
      feePassedToCustomer={false}
      finalPrice={5}
    />
  );

  expect(screen.queryByText('Payment fee')).not.toBeInTheDocument();
  expect(screen.getByText('Total')).toBeInTheDocument();
});

test('shows a gateway fee when it is included in the customer charge', () => {
  render(
    <OrderSummary
      network="MTN"
      dataAmount="1GB"
      recipientPhone="0240000000"
      price={5}
      dataPrice={5}
      fee={0.1}
      feePassedToCustomer
      finalPrice={5.1}
    />
  );

  expect(screen.getByText('Payment fee')).toBeInTheDocument();
  expect(screen.getByText('Final amount')).toBeInTheDocument();
});