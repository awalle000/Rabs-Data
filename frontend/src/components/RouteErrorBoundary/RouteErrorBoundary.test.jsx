import { render, screen } from '@testing-library/react';
import RouteErrorBoundary from './RouteErrorBoundary.jsx';

function BrokenRoute() {
  throw new Error('lazy route chunk failed');
}

test('contains route render failures and presents a reload action', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <RouteErrorBoundary>
        <BrokenRoute />
      </RouteErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('This page couldn\'t load');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(screen.queryByText('lazy route chunk failed')).not.toBeInTheDocument();
  } finally {
    consoleError.mockRestore();
  }
});